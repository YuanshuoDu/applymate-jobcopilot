import type pg from "pg"

import type { SubagentJobPayload } from "../runtime/subagents/types.js"

export type DispatchTaskRow = Record<string, unknown>
export type PendingDispatchRow = { id: string; aggregateId: string; payload: unknown; attemptCount?: number }

/** Exact, owner-independent proof that a queued child is resuming one durable wait. */
export const CHILD_WAIT_RESUMABLE_SQL = `(SELECT COUNT(*) = 1
  FROM "agent_wait_conditions" AS wait
  JOIN "agent_turns" AS waitTurn ON waitTurn."id" = wait."turnId" AND waitTurn."sessionId" = wait."sessionId"
    AND waitTurn."userId" = wait."userId" AND waitTurn."rootTaskId" = task."rootTaskId"
  JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId"
    AND step."turnId" = wait."turnId" AND step."taskId" = task."id"
  WHERE task."parentTaskId" IS NOT NULL AND wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
    AND task."status" = 'queued' AND wait."turnId" = task."turnId"
    AND task."attemptCount" >= 0 AND task."maxAttempts" > 0
    AND step."attempt" = task."attemptCount"
    AND ((wait."consumedAt" IS NULL AND step."status" = 'waiting_for_tool' AND step."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
        WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
          AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount"))
      OR (step."status" IN ('waiting_for_tool', 'completed')
        AND EXISTS (SELECT 1 FROM "agent_steps" AS continuation WHERE continuation."taskId" = task."id"
          AND continuation."sessionId" = task."sessionId" AND continuation."turnId" = task."turnId"
          AND continuation."attempt" = task."attemptCount"
          AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
            WHERE later."taskId" = task."id" AND later."sessionId" = task."sessionId"
              AND later."turnId" = task."turnId" AND later."attempt" = task."attemptCount" AND later."ordinal" > step."ordinal")
          AND continuation."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
            WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId"
              AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount")))
    AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      JOIN "agent_steps" AS currentWaitStep ON currentWaitStep."id" = currentWait."stepId"
        AND currentWaitStep."sessionId" = currentWait."sessionId" AND currentWaitStep."turnId" = currentWait."turnId"
        AND currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"
      WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId"
        AND currentWait."turnId" = task."turnId"
      ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1)
    AND wait."mode" IN ('any', 'all') AND jsonb_typeof(wait."targetTaskIds") = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) > 0
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) <= 8
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) = (SELECT COUNT(DISTINCT target."value")
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value")
      WHERE jsonb_typeof(target."value") = 'string')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END
    ) AS target("id") WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child
      WHERE child."id" = target."id" AND child."id" <> task."id" AND child."parentTaskId" = task."id"
        AND child."sessionId" = task."sessionId" AND child."turnId" = task."turnId"
        AND child."rootTaskId" = task."rootTaskId"))) = true`

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
      (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP) AS "retryDue",
      ${CHILD_WAIT_RESUMABLE_SQL} AS "childWaitResumable"
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
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1
    || (attemptCount >= maxAttempts && !(status === "queued" && task.childWaitResumable === true))) return "attempts_exhausted"
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
