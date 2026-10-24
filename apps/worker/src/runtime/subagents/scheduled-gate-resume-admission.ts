import type { Queryable } from "./pg-store-persistence.js"
import { matchScheduledGateWaitTarget } from "./scheduled-gate-wait-match.js"

/** Structural queue candidate only; callers must recheck this admission under their transaction locks. */
export const SCHEDULED_GATE_RESUMABLE_SQL = `(
  task."role" = 'prepare' AND task."taskType" = 'scheduled_taskgraph_gate' AND task."depth" = 1
  AND task."parentTaskId" = task."rootTaskId" AND task."status" = 'queued' AND task."interruptRequestedAt" IS NULL
  AND task."maxAttempts" > 0 AND task."attemptCount" >= task."maxAttempts"
  AND task."attemptCount" <= task."maxAttempts" + 50
  AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root WHERE root."id" = task."rootTaskId"
    AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId" AND root."interruptRequestedAt" IS NULL
    AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed'))
  AND EXISTS (SELECT 1 FROM "agent_items" AS item
    JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId"
    WHERE item."sessionId" = task."sessionId" AND item."turnId" = task."turnId" AND item."taskId" = task."rootTaskId"
      AND item."type" = 'question' AND item."status" = 'completed' AND item."content"->>'stage' = 'scheduled_gate'
      AND item."content"->>'answerAvailable' = 'true'
      AND item."content"->'scheduledGateChoiceBinding'->>'gateTaskId' = task."id"
      AND item."content"->'scheduledGateChoiceBinding'->>'gateAttempt' = task."attemptCount"::text
      AND item."content"->'scheduledGateChoiceResumeAcknowledgement'->>'gateTaskId' = task."id"
      AND item."content"->'scheduledGateChoiceResumeAcknowledgement'->>'itemId' = item."id"
      AND item."content"->'scheduledGateChoiceResumeAcknowledgement'->>'requestAttemptCount' = task."attemptCount"::text
      AND item."content"->'scheduledGateChoiceResumeAcknowledgement'->>'resumedAttemptCount' = (task."attemptCount" + 1)::text
      AND step."taskId" = task."rootTaskId" AND step."status" = 'waiting_for_user')
)`

export type ScheduledGateResumeAdmissionInput = Readonly<{
  taskId: string; sessionId: string; turnId: string; rootTaskId: string; userId: string; attemptCount: number
}>

const ANSWER_STEP_SQL = `SELECT DISTINCT item."stepId" FROM "agent_items" AS item
  JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId"
  WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."type" = 'question'
    AND item."status" = 'completed' AND item."content"->>'stage' = 'scheduled_gate'
    AND item."content"->'scheduledGateChoiceBinding'->>'gateTaskId' = $4
    AND item."content"->'scheduledGateChoiceBinding'->>'gateAttempt' = $5
    AND item."content"->'scheduledGateChoiceResumeAcknowledgement'->>'requestAttemptCount' = $5
    AND item."content"->'scheduledGateChoiceResumeAcknowledgement'->>'resumedAttemptCount' = $6
    AND step."taskId" = $3 AND step."status" = 'waiting_for_user' LIMIT 2`

/** Revalidates a SQL candidate using the same exact wait/ack matcher used by claim admission. */
export async function hasScheduledGateResumeAcknowledgement(client: Queryable,
  input: ScheduledGateResumeAdmissionInput): Promise<boolean> {
  const steps = await client.query<{ stepId: string }>(ANSWER_STEP_SQL, [input.sessionId, input.turnId, input.rootTaskId,
    input.taskId, String(input.attemptCount), String(input.attemptCount + 1)])
  const stepId = steps.rows.length === 1 ? steps.rows[0]?.stepId : undefined
  if (typeof stepId !== "string" || !stepId.trim()) return false
  return await matchScheduledGateWaitTarget(client, { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId,
    rootTaskId: input.rootTaskId, stepId, gateTaskId: input.taskId, requestAttemptCount: input.attemptCount }) === "pending"
}
