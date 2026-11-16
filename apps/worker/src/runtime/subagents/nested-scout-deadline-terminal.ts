import type pg from "pg"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./task-graph-child-deadline.js"
import { deleteGraphDispatch } from "./task-graph-pg-lifecycle.js"
import { hasPersistedTaskGraphMembership, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { dateValue } from "./pg-store-persistence.js"

const ACTIVE = "'queued', 'running', 'retrying', 'waiting', 'waiting_for_user'"
const TERMINAL_TURN = "'completed', 'failed', 'interrupted', 'cancelled'"
const NESTED_SCOUT_DEADLINE_FAILURE_REASON = "nested_scout_child_deadline_exceeded"

export type NestedScoutDeadlineScope = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; parentScoutId: string
}>

/** Caller owns the transaction. Re-locking is safe and preserves Session→Turn→root→parent→child order. */
export async function settleExpiredNestedScoutDescendants(
  client: pg.PoolClient,
  scope: NestedScoutDeadlineScope,
  maxSettledChildren?: number,
): Promise<string[]> {
  if (maxSettledChildren !== undefined && (!Number.isSafeInteger(maxSettledChildren) || maxSettledChildren < 1)) {
    throw new RangeError("Nested Scout deadline settlement limit must be positive")
  }
  const session = await client.query(`SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [scope.sessionId])
  const sessionRow = session.rows[0] as Record<string, unknown> | undefined
  if (!sessionRow || sessionRow.userId !== scope.userId || sessionRow.status === "aborted" || sessionRow.status === "archived") return []
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2
    AND "userId" = $3 AND "rootTaskId" = $4 AND "status" NOT IN (${TERMINAL_TURN}) FOR UPDATE`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  if (!turn.rows[0]) return []
  const rootResult = await client.query(`SELECT root."id", root."path" FROM "sub_agent_tasks" AS root
    WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3 AND root."rootTaskId" = $1
      AND root."parentTaskId" IS NULL AND root."status" IN (${ACTIVE}) AND root."interruptRequestedAt" IS NULL FOR UPDATE`,
  [scope.rootTaskId, scope.sessionId, scope.turnId])
  const root = rootResult.rows[0] as Record<string, unknown> | undefined
  if (!root) return []
  const parentResult = await client.query(`SELECT parent.* FROM "sub_agent_tasks" AS parent
    WHERE parent."id" = $1 AND parent."sessionId" = $2 AND parent."turnId" = $3 AND parent."rootTaskId" = $4
      AND parent."parentTaskId" = $4 AND parent."depth" = 1 AND parent."role" = 'scout'
      AND parent."taskType" = 'job_discovery' AND parent."interruptRequestedAt" IS NULL
      AND (parent."status" IN (${ACTIVE}) OR (parent."status" = 'failed' AND parent."failureReason" = $5)) FOR UPDATE`,
  [scope.parentScoutId, scope.sessionId, scope.turnId, scope.rootTaskId, TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON])
  const parent = parentResult.rows[0] as Record<string, unknown> | undefined
  if (!parent) return []
  const clock = await client.query<{ now: Date }>(`SELECT clock_timestamp() AS "now"`)
  const now = dateValue(clock.rows[0]?.now)
  const parentDeadline = dateValue(parent.absoluteDeadlineAt)
  if (!now || parent.status === "failed" && (!parentDeadline || parentDeadline > now)) throw new Error("nested_scout_deadline_parent_clock_invalid")
  const cascade = Boolean(parentDeadline && parentDeadline <= now)
  if (maxSettledChildren !== undefined && cascade) return []
  const children = await client.query(`SELECT child.* FROM "sub_agent_tasks" AS child
    WHERE child."parentTaskId" = $1 AND child."status" IN (${ACTIVE}) ORDER BY child."id" FOR UPDATE`, [scope.parentScoutId])
  if (children.rows.length === 0) return []
  if (parent.path !== `${String(root.path).replace(/\/$/, "")}/${scope.parentScoutId}`) throw new Error("nested_scout_deadline_parent_lineage_invalid")
  const graphScope: GraphIdentityScope = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }
  if (!await hasPersistedTaskGraphMembership(client, graphScope, scope.parentScoutId)) throw new Error("nested_scout_deadline_parent_graph_missing")
  const settled: string[] = []
  for (const raw of children.rows as Record<string, unknown>[]) {
    const child = raw
    if (child.sessionId !== scope.sessionId || child.turnId !== scope.turnId || child.rootTaskId !== scope.rootTaskId
      || child.depth !== 2 || child.role !== "scout" || child.taskType !== "job_discovery"
      || child.path !== `${String(parent.path).replace(/\/$/, "")}/${String(child.id)}`) throw new Error("nested_scout_deadline_child_lineage_invalid")
    const deadline = dateValue(child.absoluteDeadlineAt)
    if (!deadline || parentDeadline && deadline > parentDeadline) throw new Error("nested_scout_deadline_inheritance_invalid")
    if (deadline > now) {
      if (cascade) throw new Error("nested_scout_deadline_cascade_incomplete")
      continue
    }
    if (maxSettledChildren !== undefined && settled.length >= maxSettledChildren) continue
    const interrupted = child.interruptRequestedAt != null
    const status = interrupted ? "interrupted" : "failed"
    const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $6,
        "failureReason" = CASE WHEN $7 THEN "failureReason" ELSE $8 END,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "leaseSegmentStartedAt" = NULL,
        "nextAttemptAt" = NULL, "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $5
        AND "depth" = 2 AND "role" = 'scout' AND "taskType" = 'job_discovery' AND "status" IN (${ACTIVE})
        AND "absoluteDeadlineAt" <= clock_timestamp() RETURNING "id"`,
    [child.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentScoutId, status, interrupted, NESTED_SCOUT_DEADLINE_FAILURE_REASON])
    if (updated.rowCount !== 1) throw new Error("nested_scout_deadline_child_update_conflict")
    await deleteGraphDispatch(client, scope.sessionId, String(child.id))
    settled.push(String(child.id))
  }
  return settled
}
