import type pg from "pg"

import type { SubagentJobPayload } from "../runtime/subagents/types.js"

export type DispatchTaskRow = Record<string, unknown>
export type PendingDispatchRow = { id: string; aggregateId: string; payload: unknown; attemptCount?: number }

export async function lockDispatchSession(client: Pick<pg.PoolClient, "query">, sessionId: string): Promise<{ id: string; status: string; userId: string } | undefined> {
  const result = await client.query<{ id: string; status: string; userId: string }>(`SELECT session."id", session."status", session."userId" FROM "agent_sessions" AS session WHERE session."id" = $1 FOR UPDATE`, [sessionId])
  return result.rows[0]
}

export async function lockPendingDispatch(client: Pick<pg.PoolClient, "query">, input: { id: string; aggregateId: string; topic: string }): Promise<PendingDispatchRow | undefined> {
  const result = await client.query<PendingDispatchRow>(`SELECT dispatch."id", dispatch."aggregateId", dispatch."payload", dispatch."attemptCount" FROM "agent_outbox" AS dispatch
    WHERE dispatch."id" = $1 AND dispatch."aggregateId" = $2 AND dispatch."topic" = $3 AND dispatch."publishedAt" IS NULL FOR UPDATE`, [input.id, input.aggregateId, input.topic])
  return result.rows[0]
}

/** Locks the task and its lineage fences while the dispatcher validates eligibility. */
export async function lockDispatchTask(
  client: Pick<pg.PoolClient, "query">,
  input: { taskId: string; sessionId: string; userId: string },
): Promise<DispatchTaskRow | undefined> {
  const result = await client.query<DispatchTaskRow>(`SELECT task."id", task."sessionId", task."rootTaskId", task."turnId", task."status",
      task."attemptCount", task."maxAttempts", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt",
      task."nextAttemptAt", root."id" AS "rootId", root."sessionId" AS "rootSessionId", root."turnId" AS "rootTurnId",
      root."status" AS "rootStatus", turn."id" AS "turnRowId", turn."sessionId" AS "turnSessionId",
      turn."userId" AS "turnUserId", turn."status" AS "turnStatus",
      (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP) AS "retryDue"
    FROM "sub_agent_tasks" AS task
    LEFT JOIN "sub_agent_tasks" AS root
      ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    LEFT JOIN "agent_turns" AS turn
      ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = $2
    WHERE task."id" = $1 AND task."sessionId" = $3
    FOR UPDATE OF task`, [input.taskId, input.userId, input.sessionId])
  return result.rows[0]
}

export function dispatchTaskInvalidReason(task: DispatchTaskRow, payload: SubagentJobPayload, sessionId: string, userId: string): string | null {
  if (task.sessionId !== sessionId || payload.sessionId !== sessionId || task.rootTaskId !== payload.rootTaskId) return "task_scope_invalid"
  const status = typeof task.status === "string" ? task.status : null
  if (!status || !["queued", "retrying"].includes(status)) return isTerminalTaskStatus(status) ? "task_terminal" : "task_not_dispatchable"
  if ((task.leaseOwner !== null && task.leaseOwner !== undefined) || (task.leaseExpiresAt !== null && task.leaseExpiresAt !== undefined)) return "task_leased"
  if (task.interruptRequestedAt !== null && task.interruptRequestedAt !== undefined) return "task_interrupted"
  const attemptCount = Number(task.attemptCount)
  const maxAttempts = Number(task.maxAttempts)
  if (!Number.isSafeInteger(attemptCount) || !Number.isSafeInteger(maxAttempts) || attemptCount >= maxAttempts) return "attempts_exhausted"
  if (task.rootId !== task.rootTaskId || task.rootSessionId !== sessionId || task.rootTurnId !== task.turnId || !task.rootStatus) return "root_unavailable"
  if (isTerminalTaskStatus(typeof task.rootStatus === "string" ? task.rootStatus : null)) return "root_terminal"
  if (task.turnRowId !== task.turnId || task.turnSessionId !== sessionId || task.turnUserId !== userId || !task.turnStatus) return "turn_unavailable"
  if (isTerminalTaskStatus(typeof task.turnStatus === "string" ? task.turnStatus : null)) return "turn_terminal"
  return task.retryDue === false ? "retry_deferred" : null
}

export function isTerminalTaskStatus(status: string | null): boolean {
  return status !== null && ["completed", "failed", "interrupted", "cancelled", "closed"].includes(status)
}

export async function markDispatchTerminal(client: Pick<pg.PoolClient, "query">, id: string, error: string): Promise<void> {
  await client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1,
    "lastError" = $2, "publishedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "publishedAt" IS NULL`, [id, error])
}
