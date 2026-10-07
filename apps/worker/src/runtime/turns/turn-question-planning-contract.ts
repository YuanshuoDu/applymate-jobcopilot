const EVENT_TYPE = "agent.plan.clarification" as const
const SCHEMA_VERSION = "agent-harness.v2.plan-clarification.v1" as const
const MAX_CHECKPOINT_IDS = 256
const MAX_SEQUENCE = "9223372036854775807"

export const TURN_QUESTION_PLANNING_EVENT_TYPE = EVENT_TYPE
export const TURN_QUESTION_PLANNING_SCHEMA_VERSION = SCHEMA_VERSION
export type TurnQuestionPlanningSummary = Readonly<{
  observedPlanRevision: number | null
  graphRevisionAtAsk: number
  pendingSteerCount: number
  unconsumedSteerCount: number
  inputThroughSequence: string
}>
export type TurnQuestionPlanningPendingSteer = Readonly<{
  id: string
  acceptedSequence: string
  status: "accepted" | "queued" | "consumed"
  consumedByStepId: string | null
  consumingOrdinal: number | null
}>
export type TurnQuestionPlanningReceipt = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION
  sessionId: string
  turnId: string
  rootTaskId: string
  stepId: string
  toolCallId: string
  waitId: string
  questionItemId: string
  observedPlanRevision: number | null
  graphRevisionAtAsk: number
  pendingSteers: readonly TurnQuestionPlanningPendingSteer[]
  inputCheckpoint: Readonly<{ throughSequence: string; consumedInputIds: readonly string[] }>
}>
export type TurnQuestionPlanningWaitRef = Readonly<{
  stepId: string
  toolCallId: string
  waitId: string
  questionItemId: string
}>
export type TurnQuestionPlanningReadOwner = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
}>

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    || Object.values(descriptors).some(item => !item.enumerable || !("value" in item))) return null
  return value as Record<string, unknown>
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function sequence(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false
  return value.length < MAX_SEQUENCE.length || value.length === MAX_SEQUENCE.length && value <= MAX_SEQUENCE
}
function dense(value: unknown, max?: number): value is unknown[] {
  return Array.isArray(value) && (max === undefined || value.length <= max) && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}

export function turnQuestionPlanningEventKey(turnId: string, waitId: string): string {
  return `turn:${turnId}:event:planning-clarification:${waitId}`
}

export function parseTurnQuestionPlanningReceipt(value: unknown): TurnQuestionPlanningReceipt | undefined {
  const row = record(value, ["schemaVersion", "sessionId", "turnId", "rootTaskId", "stepId", "toolCallId", "waitId", "questionItemId",
    "observedPlanRevision", "graphRevisionAtAsk", "pendingSteers", "inputCheckpoint"])
  if (!row || row.schemaVersion !== SCHEMA_VERSION || ![row.sessionId, row.turnId, row.rootTaskId, row.stepId, row.toolCallId].every(id)
    || typeof row.waitId !== "string" || !/^[a-f0-9]{64}$/.test(row.waitId)
    || row.questionItemId !== `agent-wait:question:${row.waitId}`
    || !(row.observedPlanRevision === null || revision(row.observedPlanRevision)) || !revision(row.graphRevisionAtAsk)
    || !dense(row.pendingSteers)) return undefined
  const pendingSteers: TurnQuestionPlanningPendingSteer[] = []
  const seen = new Set<string>(), sequences = new Set<string>()
  for (const raw of row.pendingSteers) {
    const steer = record(raw, ["id", "acceptedSequence", "status", "consumedByStepId", "consumingOrdinal"])
    if (!steer || !id(steer.id) || !sequence(steer.acceptedSequence) || seen.has(steer.id) || sequences.has(steer.acceptedSequence)
      || !["accepted", "queued", "consumed"].includes(String(steer.status))
      || !(steer.consumedByStepId === null || id(steer.consumedByStepId))
      || !(steer.consumingOrdinal === null || Number.isSafeInteger(steer.consumingOrdinal) && Number(steer.consumingOrdinal) >= 0)
      || (steer.status === "consumed") !== (steer.consumedByStepId !== null && steer.consumingOrdinal !== null)
      || (steer.status !== "consumed" && (steer.consumedByStepId !== null || steer.consumingOrdinal !== null))) return undefined
    seen.add(steer.id); sequences.add(steer.acceptedSequence)
    pendingSteers.push({ id: steer.id, acceptedSequence: steer.acceptedSequence, status: steer.status as TurnQuestionPlanningPendingSteer["status"],
      consumedByStepId: steer.consumedByStepId as string | null, consumingOrdinal: steer.consumingOrdinal as number | null })
  }
  const checkpoint = record(row.inputCheckpoint, ["throughSequence", "consumedInputIds"])
  if (!checkpoint || !sequence(checkpoint.throughSequence) || !dense(checkpoint.consumedInputIds, MAX_CHECKPOINT_IDS)
    || checkpoint.consumedInputIds.some(value => !id(value)) || new Set(checkpoint.consumedInputIds).size !== checkpoint.consumedInputIds.length) return undefined
  return { schemaVersion: SCHEMA_VERSION, sessionId: row.sessionId as string, turnId: row.turnId as string, rootTaskId: row.rootTaskId as string,
    stepId: row.stepId as string, toolCallId: row.toolCallId as string, waitId: row.waitId, questionItemId: row.questionItemId as string,
    observedPlanRevision: row.observedPlanRevision as number | null, graphRevisionAtAsk: row.graphRevisionAtAsk as number,
    pendingSteers, inputCheckpoint: { throughSequence: checkpoint.throughSequence, consumedInputIds: checkpoint.consumedInputIds as string[] } }
}

export function summarizeTurnQuestionPlanningReceipt(receipt: TurnQuestionPlanningReceipt): TurnQuestionPlanningSummary {
  return { observedPlanRevision: receipt.observedPlanRevision, graphRevisionAtAsk: receipt.graphRevisionAtAsk,
    pendingSteerCount: receipt.pendingSteers.length,
    unconsumedSteerCount: receipt.pendingSteers.filter(input => input.status !== "consumed").length,
    inputThroughSequence: receipt.inputCheckpoint.throughSequence }
}
