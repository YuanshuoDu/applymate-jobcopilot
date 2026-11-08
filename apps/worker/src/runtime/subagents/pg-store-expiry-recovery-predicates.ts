import type pg from "pg"
import { dateValue } from "./pg-store-persistence.js"
import { CHILD_WAIT_CALL_LIFECYCLE_SQL, CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL, CHILD_WAIT_CLAIM_KEY_COLUMNS_SQL, CHILD_WAIT_CLAIM_RECOVERY_SQL, childWaitContinuationKeyMatchesSafeProjection } from "./pg-store-expiry-child-wait-claim-call-proof.js"
import { readChildWaitSourceCallProjection } from "./pg-store-expiry-child-wait-source-proof.js"
import type { TerminalCallProjection } from "./pg-store-expiry-historical-wait-binding.js"
import { readChildWaitTerminalCallProjections } from "./pg-store-expiry-historical-wait-projections.js"
import { historicalWaitClaimProofBundle } from "./pg-store-expiry-historical-wait-claim-collision.js"

export { CHILD_WAIT_CLAIM_RECOVERY_SQL } from "./pg-store-expiry-child-wait-claim-call-proof.js"
export const CHILD_WAIT_RESUMABLE_SQL = `(SELECT COUNT(*) = 1
  FROM "agent_wait_conditions" AS wait
  JOIN "agent_turns" AS waitTurn ON waitTurn."id" = wait."turnId" AND waitTurn."sessionId" = wait."sessionId"
    AND waitTurn."userId" = wait."userId" AND waitTurn."userId" = $3 AND waitTurn."rootTaskId" = task."rootTaskId"
  JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId"
    AND step."turnId" = wait."turnId" AND step."taskId" = task."id"
  WHERE task."parentTaskId" IS NOT NULL AND task."status" = 'running' AND wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"
    AND task."attemptCount" >= 0 AND task."maxAttempts" > 0 AND step."attempt" = task."attemptCount"
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
              AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount"))))
    AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      JOIN "agent_steps" AS currentWaitStep ON currentWaitStep."id" = currentWait."stepId" AND currentWaitStep."sessionId" = currentWait."sessionId" AND currentWaitStep."turnId" = currentWait."turnId" AND currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"
      WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId" AND currentWait."turnId" = task."turnId" ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1)
    AND wait."mode" IN ('any', 'all') AND jsonb_typeof(wait."targetTaskIds") = 'array' AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) > 0
    AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) <= 8 AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) = (SELECT COUNT(DISTINCT target."value")
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("value")
      WHERE jsonb_typeof(target."value") = 'string')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END
    ) AS target("id") WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child
      WHERE child."id" = target."id" AND child."id" <> task."id" AND child."parentTaskId" = task."id"
        AND child."sessionId" = task."sessionId" AND child."turnId" = task."turnId"
        AND child."rootTaskId" = task."rootTaskId"))) = true`

export const CHILD_WAIT_CONSUMED_SQL = `(SELECT CASE WHEN COUNT(*) = 1 THEN MAX(continuation."id"::text) END FROM "agent_wait_conditions" AS wait
  JOIN "agent_turns" AS waitTurn ON waitTurn."id" = wait."turnId" AND waitTurn."sessionId" = wait."sessionId" AND waitTurn."userId" = wait."userId" AND waitTurn."userId" = $3 AND waitTurn."rootTaskId" = task."rootTaskId"
  JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = wait."parentTaskId"
  JOIN "agent_steps" AS continuation ON continuation."sessionId" = source."sessionId"
    AND continuation."turnId" = source."turnId" AND continuation."taskId" = source."taskId" AND continuation."attempt" = source."attempt"
    AND continuation."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = source."sessionId"
      AND later."turnId" = source."turnId" AND later."taskId" = source."taskId" AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
  WHERE task."parentTaskId" IS NOT NULL AND task."status" = 'running' AND wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId" AND wait."consumedAt" IS NOT NULL
    AND wait."suspendedAt" IS NOT NULL AND wait."status" IN ('ready', 'timed_out') AND source."attempt" = task."attemptCount" AND source."status" IN ('waiting_for_tool', 'completed') AND continuation."status" = 'streaming'
    AND continuation."ordinal" = (SELECT MAX(currentStep."ordinal") FROM "agent_steps" AS currentStep
      WHERE currentStep."taskId" = task."id" AND currentStep."sessionId" = task."sessionId" AND currentStep."turnId" = task."turnId" AND currentStep."attempt" = task."attemptCount")
    AND wait."id" = (SELECT currentWait."id" FROM "agent_wait_conditions" AS currentWait
      JOIN "agent_steps" AS currentWaitStep ON currentWaitStep."id" = currentWait."stepId" AND currentWaitStep."sessionId" = currentWait."sessionId" AND currentWaitStep."turnId" = currentWait."turnId" AND currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"
      WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId" AND currentWait."turnId" = task."turnId" ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1))`

export async function hasBlockingExternalCall(client: pg.PoolClient, task: Record<string, unknown>, ignoredEventId?: string, continuationId?: string): Promise<boolean> {
  const sourceCallProjection = continuationId ? await readChildWaitSourceCallProjection(client, task, continuationId) : null
  const run = (projections: readonly TerminalCallProjection[]) => client.query<{ id: string; claimWaitId: string | null; waitDeadlineAt: unknown; outcomeDeadlineAt: unknown; sourceWaitKey: string | null; continuationWaitKey: string | null; waitCallCandidate: boolean }>(`WITH latest_wait AS MATERIALIZED (
      SELECT wait."id", wait."stepId", waitStep."attempt", wait."deadlineAt", wait."result" FROM "agent_wait_conditions" AS wait
      JOIN "agent_steps" AS waitStep ON waitStep."id" = wait."stepId" AND waitStep."sessionId" = wait."sessionId" AND waitStep."turnId" = wait."turnId" AND waitStep."taskId" = wait."parentTaskId"
      WHERE wait."parentTaskId" = $2 AND wait."sessionId" = $1 AND wait."turnId" = $3 AND waitStep."attempt" BETWEEN 1 AND $6
      ORDER BY waitStep."attempt" DESC, waitStep."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 1
    )
    SELECT started."id", claim."waitId" AS "claimWaitId", claim."waitDeadlineAt", claim."outcomeDeadlineAt", claim."sourceWaitKey", claim."continuationWaitKey",
      (started."payload"->>'toolName' = 'wait_subagents' OR EXISTS (SELECT 1 FROM "agent_items" AS hint WHERE hint."id" = started."itemId"
        AND hint."sessionId" = started."sessionId" AND hint."turnId" = started."turnId" AND hint."taskId" = started."taskId"
        AND hint."type" = 'tool_call' AND hint."content"->>'toolName' = 'wait_subagents')) AS "waitCallCandidate"
    FROM "agent_events" AS started
    LEFT JOIN LATERAL (SELECT latest_wait."id" AS "waitId", latest_wait."deadlineAt" AS "waitDeadlineAt",
        latest_wait."result"->'outcome'->>'deadlineAt' AS "outcomeDeadlineAt", ${CHILD_WAIT_CLAIM_KEY_COLUMNS_SQL} FROM latest_wait WHERE ${CHILD_WAIT_CLAIM_RECOVERY_SQL}) AS claim ON TRUE
    WHERE started."sessionId" = $1 AND started."taskId" = $2 AND started."type" IN ('tool_call.started', 'model.started')
      AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled WHERE settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
        AND settled."correlationId" = started."correlationId" AND ((started."type" = 'tool_call.started' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')
          AND ${CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL}) OR (started."type" = 'model.started' AND settled."type" IN ('model.completed', 'model.failed'))))
      AND NOT (started."type" = 'model.started' AND $10::text IS NOT NULL AND started."actor" = 'subagent' AND started."itemId" IS NULL AND started."turnId" = $3 AND started."correlationId" = $10 AND started."idempotencyKey" = 'task:' || $2 || ':event:model-started:' || $10
        AND started."payload" = jsonb_build_object('taskId', $2, 'provider', started."payload"->>'provider', 'model', started."payload"->>'model') AND jsonb_typeof(started."payload"->'provider') = 'string' AND jsonb_typeof(started."payload"->'model') = 'string')
      AND NOT (started."type" = 'tool_call.started' AND EXISTS (
        SELECT 1 FROM "sub_agent_tasks" AS owner JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = owner."id" JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = owner."id"
        JOIN "agent_items" AS call ON call."id" = started."itemId" AND call."sessionId" = source."sessionId" AND call."turnId" = source."turnId" AND call."taskId" = source."taskId" AND call."stepId" = source."id"
        WHERE owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3 AND owner."rootTaskId" = $4 AND owner."status" = 'running'
          AND owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7 AND source."attempt" = $6 AND wait."sessionId" = $1 AND wait."turnId" = $3 AND wait."userId" = $8
          AND ((wait."status" = 'waiting' AND wait."suspendedAt" IS NULL AND wait."consumedAt" IS NULL
              AND source."status" IN ('streaming', 'waiting_for_tool') AND source."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = owner."id" AND current."sessionId" = $1 AND current."turnId" = $3 AND current."attempt" = $6))
            OR (wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL
              AND source."status" IN ('waiting_for_tool', 'completed') AND EXISTS (SELECT 1 FROM "agent_steps" AS next WHERE next."sessionId" = source."sessionId" AND next."turnId" = source."turnId" AND next."taskId" = source."taskId" AND next."attempt" = source."attempt"
                AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = source."sessionId"
                  AND later."turnId" = source."turnId" AND later."taskId" = source."taskId" AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
                AND (wait."consumedAt" IS NOT NULL OR next."status" = 'streaming')
                AND next."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = owner."id" AND current."sessionId" = $1 AND current."turnId" = $3 AND current."attempt" = $6)))
            OR (wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL AND source."status" = 'waiting_for_tool' AND source."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."taskId" = owner."id" AND current."sessionId" = $1 AND current."turnId" = $3 AND current."attempt" = $6)))
          AND wait."id" = (SELECT latest."id" FROM "agent_wait_conditions" AS latest WHERE latest."parentTaskId" = owner."id" AND latest."stepId" = source."id" ORDER BY latest."createdAt" DESC, latest."id" DESC LIMIT 1)
          AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents' AND call."content"->>'toolVersion' = '1' AND call."status" IN ('started', 'streaming', 'completed') AND call."content"->>'toolCallId' = started."correlationId" AND started."itemId" = call."id" AND started."turnId" = $3
          AND (CASE WHEN jsonb_typeof(call."content"->'input') = 'object' THEN (call."content"->'input') - 'taskIds'::text ELSE '{}'::jsonb END) = jsonb_build_object('idempotencyKey', wait."idempotencyKey", 'mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
          AND (SELECT jsonb_agg(target."id" ORDER BY target."id") FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(call."content"->'input'->'taskIds') = 'array' THEN call."content"->'input'->'taskIds' ELSE '[]'::jsonb END) AS target("id")) = wait."targetTaskIds"
          AND wait."result"->'request' = jsonb_build_object('targetTaskIds', wait."targetTaskIds", 'mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
          AND wait."result"->'outcome'->>'waitId' = wait."id" AND wait."result"->'outcome'->>'status' = wait."status"
          AND wait."result"->'outcome'->'taskIds' = wait."targetTaskIds" AND wait."result"->'outcome'->'matchedTaskIds' = wait."matchedTaskIds"
          AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) BETWEEN 1 AND 8
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id")
            WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child WHERE child."id" = target."id" AND child."parentTaskId" = owner."id" AND child."rootTaskId" = $4 AND child."sessionId" = $1 AND child."turnId" = $3))))
      AND ($9::text IS NULL OR started."id" <> $9) LIMIT 2`, [task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount, task.leaseExpiresAt, task.userId, ignoredEventId ?? null, continuationId ?? null,
    sourceCallProjection?.rawCallId ?? null, sourceCallProjection?.projectedCallId ?? null,
    JSON.stringify(projections.length ? historicalWaitClaimProofBundle(projections) : [])])
  const result = await run([])
  if (!result.rows.length) return false
  const validClaim = (rows: typeof result.rows) => rows.length === 1 && typeof rows[0]?.claimWaitId === "string"
    && childWaitContinuationKeyMatchesSafeProjection(rows[0].sourceWaitKey, rows[0].continuationWaitKey)
    && Number.isFinite(dateValue(rows[0].waitDeadlineAt)?.getTime()) && typeof rows[0].outcomeDeadlineAt === "string"
    && dateValue(rows[0].outcomeDeadlineAt)?.toISOString() === rows[0].outcomeDeadlineAt
    && dateValue(rows[0].waitDeadlineAt)?.getTime() === dateValue(rows[0].outcomeDeadlineAt)?.getTime()
  if (validClaim(result.rows)) return false
  if (!result.rows.some(row => row.waitCallCandidate === true)) return true
  const projections = await readChildWaitTerminalCallProjections(client, task)
  if (!projections.length) return true
  const settled = await run(projections)
  return settled.rows.length > 0 && !validClaim(settled.rows)
}
