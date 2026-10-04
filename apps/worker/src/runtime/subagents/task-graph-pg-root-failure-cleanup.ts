import type { SubagentTaskRecord, SubagentTaskStatus } from "./types.js"
import type { TurnLease } from "../turns/lease.js"
import type { Queryable } from "./pg-store-persistence.js"
import { deleteGraphDispatch, persistGraphTransition, prepareGraphTransition, reconcileGraphDependents, type PreparedGraphTransition } from "./task-graph-pg-lifecycle.js"
import { hasPersistedTaskGraphMembership, loadTaskGraph, type GraphIdentityScope } from "./task-graph-pg-state.js"

type PgSubagentClient = Queryable
type FailedRootIdentity = Pick<SubagentTaskRecord, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "parentTaskId" | "taskType">
type LockedChild = Readonly<{ id: string; status: SubagentTaskStatus; attemptCount: number }>
type RecoveredStatus = "queued" | "failed" | "interrupted"
export type RootFailureCleanupAuthority =
  | Readonly<{ kind: "persisted-root-result-failed"; lease: Pick<TurnLease, "ownerId" | "leaseVersion"> }>
  | Readonly<{ kind: "terminal-failed-turn-recovery" }>

export async function settleRecoveredTaskGraph(
  client: PgSubagentClient,
  input: {
    task: SubagentTaskRecord; graph: PreparedGraphTransition | null; status: RecoveredStatus
    terminal: boolean; closedSession: boolean; now: Date; canonicalFailedRoot: boolean
  },
): Promise<void> {
  if (input.canonicalFailedRoot) await cleanupFailedRootTaskGraph(client, input.task, { kind: "terminal-failed-turn-recovery" }, input.now)
  else if (input.graph) {
    const options = { stream: !input.closedSession, allowClosedSession: input.closedSession }
    await persistGraphTransition(client, input.graph, input.now, options)
    if (input.terminal) await reconcileGraphDependents(client, input.graph.scope, input.now, options)
  }
  if (input.status === "queued") await resetRecoveredDispatch(client, input.task.sessionId, input.task.id)
  else await deleteGraphDispatch(client, input.task.sessionId, input.task.id)
}

/** Cleanup requires either a live owned Turn after root.failed persists or terminal-failed Turn recovery. */
export async function cleanupFailedRootTaskGraph(
  client: PgSubagentClient,
  root: FailedRootIdentity,
  authority: RootFailureCleanupAuthority,
  now: Date,
): Promise<void> {
  if (![root.id, root.userId, root.sessionId, root.turnId, root.rootTaskId].every(nonEmpty)
    || root.rootTaskId !== root.id || root.parentTaskId !== null || root.taskType !== "root") {
    throw new Error("task_graph_failed_root_scope_invalid")
  }
  const session = await client.query(`SELECT session."userId", session."status" FROM "agent_sessions" AS session
    WHERE session."id" = $1 FOR UPDATE`, [root.sessionId])
  const sessionRow = session.rows[0] as Record<string, unknown> | undefined
  if (!sessionRow || sessionRow.userId !== root.userId) throw new Error("task_graph_session_fenced")
  if (sessionRow.status === "aborted" || sessionRow.status === "archived") return

  const turn = authority.kind === "persisted-root-result-failed"
    ? await client.query(`SELECT turn."id", turn."sessionId", turn."userId", turn."rootTaskId", turn."status"
        FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
          AND turn."rootTaskId" = $4 AND turn."status" = 'in_progress'
          AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6
          AND turn."leaseExpiresAt" > clock_timestamp() FOR UPDATE`,
      [root.turnId, root.sessionId, root.userId, root.id, authority.lease.ownerId, authority.lease.leaseVersion])
    : await client.query(`SELECT turn."id", turn."sessionId", turn."userId", turn."rootTaskId", turn."status"
        FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
          AND turn."rootTaskId" = $4 FOR UPDATE`,
      [root.turnId, root.sessionId, root.userId, root.id])
  const turnRow = turn.rows[0] as Record<string, unknown> | undefined
  if (!turnRow) throw new Error("task_graph_turn_fenced")
  if (authority.kind === "persisted-root-result-failed" && turnRow.status !== "in_progress") throw new Error("task_graph_turn_fenced")
  if (authority.kind === "terminal-failed-turn-recovery" && turnRow.status !== "failed") return

  const rootTask = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId",
      task."parentTaskId", task."taskType", task."status", session."userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $1
      AND task."parentTaskId" IS NULL AND task."taskType" = 'root' AND task."status" = 'failed'
      AND session."userId" = $4 FOR UPDATE OF task`, [root.id, root.sessionId, root.turnId, root.userId])
  if (!rootTask.rows[0]) throw new Error("task_graph_failed_root_fenced")

  const scope: GraphIdentityScope = {
    userId: root.userId, sessionId: root.sessionId, turnId: root.turnId!, rootTaskId: root.id, parentTaskId: root.id,
  }
  const graph = await loadTaskGraph(client, scope, true)
  if (!graph.item || !graph.snapshot || !graph.state) return
  const taskIds = graph.snapshot.nodes.map(node => node.taskId)
  for (const taskId of taskIds) {
    if (!await hasPersistedTaskGraphMembership(client, scope, taskId)) throw new Error("task_graph_failed_root_membership_invalid")
  }
  if (!taskIds.length) return

  const children = await client.query(`SELECT task."id", task."status", task."attemptCount"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6
    ORDER BY task."id" FOR UPDATE OF task`, [taskIds, root.sessionId, root.turnId, root.id, root.id, root.userId])
  const byId = new Map<string, LockedChild>()
  for (const value of children.rows) {
    const row = value as Record<string, unknown>
    if (typeof row.id !== "string" || typeof row.status !== "string") throw new Error("task_graph_failed_root_child_scope_invalid")
    byId.set(row.id, { id: row.id, status: row.status as SubagentTaskStatus, attemptCount: Number(row.attemptCount) })
  }
  if (byId.size !== taskIds.length || taskIds.some(id => !byId.has(id))) throw new Error("task_graph_failed_root_child_scope_invalid")

  for (const node of graph.snapshot.nodes) {
    const child = byId.get(node.taskId)!
    if (!isActive(child.status)) continue
    if (child.status === "running") {
      await client.query(`UPDATE "sub_agent_tasks" AS task SET "interruptRequestedAt" = $7, "updatedAt" = $7
        WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
          AND task."parentTaskId" = $5 AND task."status" = 'running' AND task."interruptRequestedAt" IS NULL
          AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $6)` ,
      [child.id, root.sessionId, root.turnId, root.id, root.id, root.userId, now])
      continue
    }

    const transition = await prepareGraphTransition(client, {
      taskId: child.id, sessionId: root.sessionId, type: "task.cancelled", attemptCount: child.attemptCount,
    })
    if (!transition || "blocked" in transition) throw new Error("task_graph_failed_root_transition_invalid")
    const updated = await client.query(`UPDATE "sub_agent_tasks" AS task SET "status" = 'cancelled',
        "failureReason" = 'Root task failed.', "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
        "nextAttemptAt" = NULL, "completedAt" = $7, "updatedAt" = $7
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND task."parentTaskId" = $5 AND task."status" = $8
        AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $6)` ,
    [child.id, root.sessionId, root.turnId, root.id, root.id, root.userId, now, child.status])
    if (updated.rowCount !== 1) throw new Error("task_graph_failed_root_child_fenced")
    await deleteGraphDispatch(client, root.sessionId, child.id)
    await persistGraphTransition(client, transition, now)
  }
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function isActive(status: string): status is Extract<SubagentTaskStatus, "queued" | "retrying" | "waiting" | "waiting_for_user" | "running"> {
  return status === "queued" || status === "retrying" || status === "waiting" || status === "waiting_for_user" || status === "running"
}
async function resetRecoveredDispatch(client: PgSubagentClient, sessionId: string, taskId: string): Promise<void> {
  await client.query(`UPDATE "agent_outbox" SET "publishedAt" = NULL, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
    WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [sessionId, `subagent-dispatch:${taskId}`])
}
