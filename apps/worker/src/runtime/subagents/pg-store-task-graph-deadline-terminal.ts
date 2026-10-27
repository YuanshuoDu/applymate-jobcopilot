import type pg from "pg"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./task-graph-child-deadline.js"
import { json, rowToTask, SELECT_TASK } from "./pg-store-persistence.js"
import { deleteGraphDispatch, persistGraphTransition, prepareGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"
import { taskGraphVerificationResult, unverifiedFailureReport } from "./pg-store-lifecycle-result.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import type { SubagentTaskRecord } from "./types.js"

type DeadlineCandidate = Readonly<{ id: string; sessionId: string; turnId: string; rootTaskId: string; userId: string }>
const ACTIVE = "'queued', 'running', 'retrying', 'waiting', 'waiting_for_user'"
const TERMINAL_TURN = "'completed', 'failed', 'interrupted', 'cancelled'"

export function taskGraphDeadlineFailureResult(value: unknown, node: StoredTaskGraphNode): unknown {
  if (node.verificationDisposition !== "typed" || !node.verification) return value ?? null
  return taskGraphVerificationResult(value, unverifiedFailureReport(node), undefined, null)
}

/** Caller owns one transaction. Locks follow Session, Turn, root, child order. */
export async function expireTaskGraphChild(client: pg.PoolClient, candidate: DeadlineCandidate): Promise<SubagentTaskRecord | null> {
  const session = await client.query(`SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [candidate.sessionId])
  const owner = session.rows[0] as Record<string, unknown> | undefined
  if (!owner || owner.userId !== candidate.userId || owner.status === "aborted" || owner.status === "archived") return null
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [candidate.userId])

  const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2
    AND "userId" = $3 AND "rootTaskId" = $4 AND "status" NOT IN (${TERMINAL_TURN}) FOR UPDATE`,
  [candidate.turnId, candidate.sessionId, candidate.userId, candidate.rootTaskId])
  if (!turn.rows[0]) return null
  const root = await client.query(`SELECT root."id" FROM "sub_agent_tasks" AS root JOIN "agent_sessions" AS session
      ON session."id" = root."sessionId" WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3
        AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL AND session."userId" = $4
        AND root."status" IN (${ACTIVE}) AND root."interruptRequestedAt" IS NULL FOR UPDATE OF root`,
  [candidate.rootTaskId, candidate.sessionId, candidate.turnId, candidate.userId])
  if (!root.rows[0]) return null

  const locked = await client.query(`SELECT task.*, session."userId" AS "userId" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 AND session."userId" = $5 AND task."status" IN (${ACTIVE})
      AND task."interruptRequestedAt" IS NULL AND task."absoluteDeadlineAt" <= clock_timestamp() FOR UPDATE OF task`,
  [candidate.id, candidate.sessionId, candidate.turnId, candidate.rootTaskId, candidate.userId])
  const row = locked.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  const attemptCount = Number(row.attemptCount)
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new Error("task_graph_deadline_attempt_invalid")
  const prepared = await prepareGraphTransition(client, { taskId: candidate.id, sessionId: candidate.sessionId,
    type: "task.failed", attemptCount, failureReason: TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON })
  if (!prepared || "blocked" in prepared) return null
  const node = prepared.snapshot.nodes.find(item => item.taskId === candidate.id)
  if (!node) throw new Error("task_graph_deadline_child_missing")
  const typed = node.verificationDisposition === "typed" && node.verification !== undefined
  const result = taskGraphDeadlineFailureResult(row.result, node)
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'failed',
      "failureReason" = $6, "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "leaseSegmentStartedAt" = NULL,
      "nextAttemptAt" = NULL, "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp(),
      "result" = CASE WHEN $7 THEN $8::jsonb ELSE "result" END
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
      AND "status" = $5 AND "attemptCount" = $9 AND "interruptRequestedAt" IS NULL
      AND "absoluteDeadlineAt" <= clock_timestamp()
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $10
        AND session."status" NOT IN ('aborted', 'archived')) RETURNING "updatedAt"`,
  [candidate.id, candidate.sessionId, candidate.turnId, candidate.rootTaskId, row.status, TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON,
    typed, typed ? json(result, null, "subagent_task_result") : null, attemptCount, candidate.userId])
  if (updated.rowCount !== 1) return null
  const completedAt = updated.rows[0]?.updatedAt instanceof Date ? updated.rows[0].updatedAt : new Date(String(updated.rows[0]?.updatedAt))
  if (!Number.isFinite(completedAt.getTime())) throw new Error("task_graph_deadline_clock_unavailable")
  await deleteGraphDispatch(client, candidate.sessionId, candidate.id)
  await persistGraphTransition(client, prepared, completedAt)
  await reconcileGraphDependents(client, prepared.scope, completedAt)
  const refreshed = await client.query(SELECT_TASK, [candidate.id, candidate.sessionId])
  if (!refreshed.rows[0]) throw new Error("task_graph_deadline_child_disappeared")
  return rowToTask(refreshed.rows[0] as Record<string, unknown>)
}
