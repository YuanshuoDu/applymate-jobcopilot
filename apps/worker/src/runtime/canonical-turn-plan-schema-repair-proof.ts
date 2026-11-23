import { PLAN_SCHEMA_REPAIR_ERROR_CODE } from "./turns/turn-execution-plan-repair.js"
import { parseModelCompletedReceipt } from "./turns/model-completed-receipt.js"

type Row = Record<string, unknown>
type Scope = { readonly userId: string; readonly sessionId: string; readonly turnId: string; readonly rootTaskId: string }
export type PlanSchemaRepairRestore = Readonly<{ sourceStepId: string; sourceStepOrdinal: number; retryPending: boolean }>
const DATABASE_COST_SCALE = 100_000_000

function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
function invalid(): never { throw new Error("plan_schema_repair_proof_invalid") }
function exactKeys(value: Row, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
    && expected.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && "value" in descriptor })
}
function sequence(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value)
  if (typeof value === "bigint" && value > 0n) return value
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}
function eventScope(event: Row, type: string, stepId: string, scope: Scope, key: string): boolean {
  return event.type === type && event.correlationId === stepId && event.idempotencyKey === key
    && event.userId === scope.userId && event.sessionId === scope.sessionId && event.turnId === scope.turnId
    && event.taskId === scope.rootTaskId && event.actor === "orchestrator" && event.itemId === null
    && typeof event.id === "string" && event.id.length > 0
}
function modelStartPayload(event: Row, rootTaskId: string): boolean {
  const payload = object(event.payload)
  return !!payload && exactKeys(payload, ["provider", "model", "taskId"]) && payload.taskId === rootTaskId
    && typeof payload.provider === "string" && payload.provider.length > 0
    && typeof payload.model === "string" && payload.model.length > 0
}
function amount(value: unknown, integer: boolean): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 && (!integer || Number.isSafeInteger(parsed)) ? parsed : null
}
function databaseCostUnits(value: number): number | null {
  if (value < 0 || value >= 10_000) return null
  const scaled = value * DATABASE_COST_SCALE
  const roundingMargin = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2
  const units = Math.floor(scaled + 0.5 + roundingMargin)
  return units < 10_000 * DATABASE_COST_SCALE ? units : null
}
function usageValues(value: unknown): { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null {
  if (value === null) return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  const usage = object(value)
  if (!usage || !exactKeys(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])) return null
  const inputTokens = amount(usage.inputTokens, true), outputTokens = amount(usage.outputTokens, true)
  const estimatedCostUsd = amount(usage.estimatedCostUsd, false)
  return inputTokens === null || outputTokens === null || estimatedCostUsd === null
    ? null : { inputTokens, outputTokens, estimatedCostUsd }
}

/** Restores the one-use Root planning repair only from its exact durable Step proof. */
export function restorePlanSchemaRepair(input: {
  readonly steps: readonly Row[]
  readonly items: readonly Row[]
  readonly events: readonly Row[]
  readonly scope: Scope
}): PlanSchemaRepairRestore | undefined {
  const markedSteps = input.steps.filter(step => step.errorCode === PLAN_SCHEMA_REPAIR_ERROR_CODE)
  const markedCloses = input.events.filter(event => event.type === "step.completed"
    && object(event.payload)?.errorCode === PLAN_SCHEMA_REPAIR_ERROR_CODE)
  if (!markedSteps.length && !markedCloses.length) return undefined

  const candidateIds = new Set<string>()
  for (const step of markedSteps) {
    if (typeof step.id !== "string" || !step.id) invalid()
    candidateIds.add(step.id)
  }
  for (const event of markedCloses) {
    const payload = object(event.payload), correlationId = event.correlationId, stepId = payload?.stepId
    if (typeof correlationId !== "string" || !correlationId || typeof stepId !== "string" || !stepId) invalid()
    candidateIds.add(correlationId)
    candidateIds.add(stepId)
  }
  if (candidateIds.size !== 1 || markedSteps.length !== 1 || markedCloses.length !== 1) invalid()
  const sourceStepId = candidateIds.values().next().value as string
  const matchingSteps = input.steps.filter(step => step.id === sourceStepId)
  const source = matchingSteps[0]
  const closes = input.events.filter(event => event.type === "step.completed" && event.correlationId === sourceStepId)
  if (matchingSteps.length !== 1 || !source || source.status !== "completed"
    || source.taskId !== input.scope.rootTaskId || source.errorCode !== PLAN_SCHEMA_REPAIR_ERROR_CODE || source.finishReason !== "tool_calls"
    || !Number.isSafeInteger(source.ordinal) || Number(source.ordinal) < 0
    || closes.length !== 1 || closes[0] !== markedCloses[0]) invalid()

  if (input.items.some(item => item.stepId === sourceStepId && (item.type === "tool_call" || item.type === "tool_result"))) invalid()
  if (input.events.some(event => (event.type === "model.failed" || event.type === "step.failed") && event.correlationId === sourceStepId)) invalid()

  const forStep = (type: string) => input.events.filter(event => event.type === type && event.correlationId === sourceStepId)
  const starts = forStep("model.started"), completions = forStep("model.completed"), usages = forStep("model.usage")
  const closed = closes[0]!
  if (starts.length !== 1 || completions.length !== 1 || usages.length !== 1) invalid()
  const started = starts[0]!, completed = completions[0]!, usageEvent = usages[0]!
  const startPayload = object(started.payload), completedReceipt = parseModelCompletedReceipt(completed.payload)
  const usagePayload = object(usageEvent.payload), closePayload = object(closed.payload)
  const startSequence = sequence(started.sequence), completedSequence = sequence(completed.sequence)
  const usageSequence = sequence(usageEvent.sequence), closeSequence = sequence(closed.sequence)
  if (!eventScope(started, "model.started", sourceStepId, input.scope, `turn:${input.scope.turnId}:event:model-started:${sourceStepId}`)
    || !modelStartPayload(started, input.scope.rootTaskId)
    || !eventScope(completed, "model.completed", sourceStepId, input.scope, `turn:${input.scope.turnId}:event:model-completed:${sourceStepId}`)
    || !completedReceipt || completedReceipt.taskId !== input.scope.rootTaskId || completedReceipt.toolCallCount !== 0
    || completedReceipt.provider !== startPayload?.provider || completedReceipt.model !== startPayload?.model
    || completed.causationId !== started.id
    || !eventScope(usageEvent, "model.usage", sourceStepId, input.scope, `turn:${input.scope.turnId}:event:model-usage:${sourceStepId}`)
    || !usagePayload || !exactKeys(usagePayload, ["provider", "model", "usage", "taskId"])
    || usagePayload.taskId !== input.scope.rootTaskId || typeof usagePayload.provider !== "string" || !usagePayload.provider
    || typeof usagePayload.model !== "string" || !usagePayload.model || usageEvent.causationId !== completed.id
    || !eventScope(closed, "step.completed", sourceStepId, input.scope, `turn:${input.scope.turnId}:event:step-completed:${sourceStepId}`)
    || !closePayload || !exactKeys(closePayload, ["stepId", "status", "errorCode", "taskId"])
    || closePayload.stepId !== sourceStepId || closePayload.status !== "completed"
    || closePayload.errorCode !== PLAN_SCHEMA_REPAIR_ERROR_CODE || closePayload.taskId !== input.scope.rootTaskId
    || closed.causationId !== usageEvent.id || startSequence === null || completedSequence === null
    || usageSequence === null || closeSequence === null
    || startSequence >= completedSequence || completedSequence >= usageSequence || usageSequence >= closeSequence) invalid()

  const usage = usageValues(usagePayload.usage)
  const stepInput = amount(source.inputTokens, true), stepOutput = amount(source.outputTokens, true)
  const stepCost = amount(source.estimatedCostUsd, false)
  const stepCostUnits = stepCost === null ? null : databaseCostUnits(stepCost)
  const usageCostUnits = usage ? databaseCostUnits(usage.estimatedCostUsd) : null
  if (!usage || stepInput !== usage.inputTokens || stepOutput !== usage.outputTokens || stepCost === null
    || stepCostUnits === null || usageCostUnits === null || stepCostUnits !== usageCostUnits) invalid()

  let retryPending = true
  const sourceOrdinal = Number(source.ordinal), laterRootSteps: Row[] = []
  const seenOrdinals = new Set<number>([sourceOrdinal]), seenIds = new Set<string>([sourceStepId])
  for (const step of input.steps.filter(row => row.taskId === input.scope.rootTaskId && row.id !== sourceStepId)) {
    const ordinal = Number(step.ordinal)
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || seenOrdinals.has(ordinal)
      || typeof step.id !== "string" || !step.id || seenIds.has(step.id)) invalid()
    seenOrdinals.add(ordinal)
    seenIds.add(step.id)
    if (ordinal > sourceOrdinal) laterRootSteps.push(step)
  }
  for (const step of laterRootSteps) {
    const admissions = input.events.filter(event => event.type === "model.started" && event.correlationId === step.id)
    if (!admissions.length) continue
    if (admissions.length !== 1 || !eventScope(admissions[0]!, "model.started", step.id as string, input.scope,
        `turn:${input.scope.turnId}:event:model-started:${step.id}`) || !modelStartPayload(admissions[0]!, input.scope.rootTaskId)) invalid()
    const admissionSequence = sequence(admissions[0]!.sequence)
    if (admissionSequence === null || admissionSequence <= closeSequence) invalid()
    retryPending = false
  }
  for (const event of input.events.filter(row => row.type === "model.started" && row.taskId === input.scope.rootTaskId)) {
    const eventSequence = sequence(event.sequence)
    if (eventSequence === null) invalid()
    if (eventSequence <= closeSequence) continue
    const matchingSteps = input.steps.filter(step => step.id === event.correlationId)
    if (matchingSteps.length !== 1 || matchingSteps[0]?.taskId !== input.scope.rootTaskId
      || !Number.isSafeInteger(matchingSteps[0]?.ordinal) || Number(matchingSteps[0]?.ordinal) <= sourceOrdinal) invalid()
  }
  for (const event of input.events.filter(row => row.type === "model.started" && row.taskId == null
    && row.actor === "orchestrator" && row.userId === input.scope.userId
    && row.sessionId === input.scope.sessionId && row.turnId === input.scope.turnId)) {
    const eventSequence = sequence(event.sequence)
    if (eventSequence === null || eventSequence > closeSequence) invalid()
  }
  return { sourceStepId, sourceStepOrdinal: Number(source.ordinal), retryPending }
}
