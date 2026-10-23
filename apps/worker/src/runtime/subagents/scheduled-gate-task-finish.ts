import { parseScheduledGateTaskEnvelope, type ScheduledGateTaskEnvelope } from "./scheduled-gate-contract.js"

export type ScheduledGateTaskFinishInput = Readonly<{
  taskId: string
  expectedTaskId: string
  taskStatus: unknown
  attemptCount: number
  expectedAttemptCount: number
  result: unknown
  expectedJobIds: readonly string[]
}>

/** Accepts only the completed fixed Gate envelope for the exact current task attempt and prepared set. */
export function validateScheduledGateTaskFinish(input: ScheduledGateTaskFinishInput): ScheduledGateTaskEnvelope | null {
  if (input.taskId !== input.expectedTaskId || input.taskStatus !== "completed"
    || !positive(input.attemptCount) || input.attemptCount !== input.expectedAttemptCount) return null
  const envelope = parseScheduledGateTaskEnvelope(input.result, input.taskStatus, input.expectedJobIds)
  return envelope?.structuredResult.status === "completed" ? envelope : null
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
