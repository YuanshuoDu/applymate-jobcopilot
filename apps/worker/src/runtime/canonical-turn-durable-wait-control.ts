import { isDeepStrictEqual } from "node:util"
import type { DurableWaitControlReader } from "./tools/coordination-types.js"
import { lookupArchivedWaitControl, parseArchivedWaitReference } from "./turns/durable-wait-control.js"
import { hasResolvedWaitOutcome, type RecoveredArchivedWaitControl } from "./turns/turn-execution-wait.js"
import type { TurnExecutionIdentity } from "./turns/turn-execution-types.js"
import { TurnEngineError } from "./turns/turn-engine-types.js"
import type { TurnLease } from "./turns/lease.js"

type Row = Record<string, unknown>
type Observation = { readonly id: string; readonly content: unknown }
function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
function payload(value: unknown): Row | null { const row = object(value); return object(row?.payload ?? row) }
function scopedTask(value: unknown, rootTaskId: string): boolean { return value === null || value === undefined || value === rootTaskId }
function boundedString(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value }
function invalid(): never { throw new TurnEngineError("persistence_conflict", "Archived wait recovery is unavailable") }
function persistedNumber(value: unknown, integer = false): number {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number) || number < 0 || integer && !Number.isSafeInteger(number)) return invalid()
  return number
}
function persistedText(value: unknown): string | null { return typeof value === "string" ? value : value == null ? null : invalid() }
function exactKeys(value: Row | null, keys: readonly string[]): value is Row {
  return !!value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key))
    && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && "value" in descriptor })
}
function eventSequence(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}
function jsonUsageValue(value: unknown, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value)) return invalid()
  return value
}
function modelUsage(events: readonly Row[], stepId: string, identity: TurnExecutionIdentity): { inputTokens: number; outputTokens: number; estimatedCostUsd: number } {
  const { rootTaskId, turnId } = identity
  const rows = events.filter(event => ["model.started", "model.completed", "model.usage"].includes(String(event.type)) && event.correlationId === stepId)
  const started = rows.filter(event => event.type === "model.started"), completed = rows.filter(event => event.type === "model.completed"), usages = rows.filter(event => event.type === "model.usage")
  const start = started[0], done = completed[0], event = usages[0], body = payload(event?.payload)
  if (started.length !== 1 || completed.length !== 1 || usages.length !== 1 || !start || !done || !event
    || ![start, done, event].every(row => row.userId === identity.userId && row.sessionId === identity.sessionId && row.turnId === turnId
      && row.taskId === rootTaskId && row.actor === "orchestrator" && row.itemId === null && typeof row.id === "string" && !!row.id)
    || start.idempotencyKey !== "turn:" + turnId + ":event:model-started:" + stepId
    || done.idempotencyKey !== "turn:" + turnId + ":event:model-completed:" + stepId
    || event.idempotencyKey !== "turn:" + turnId + ":event:model-usage:" + stepId
    || ![start, done].every(row => { const value = payload(row.payload); return exactKeys(value, ["provider", "model", "taskId"]) && value.taskId === rootTaskId && boundedString(value.provider, 128) && boundedString(value.model, 128) })
    || !exactKeys(body, ["provider", "model", "usage", "taskId"]) || body.taskId !== rootTaskId
    || body.provider !== payload(start.payload)?.provider || body.model !== payload(start.payload)?.model
    || body.provider !== payload(done.payload)?.provider || body.model !== payload(done.payload)?.model
    || done.causationId !== start.id || event.causationId !== done.id) invalid()
  const startSequence = eventSequence(start.sequence), doneSequence = eventSequence(done.sequence), usageSequence = eventSequence(event.sequence)
  if (startSequence === null || doneSequence === null || usageSequence === null || startSequence >= doneSequence || doneSequence >= usageSequence) invalid()
  if (body.usage === null) return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  const usage = object(body.usage)
  if (!exactKeys(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])) invalid()
  return { inputTokens: jsonUsageValue(usage.inputTokens, true), outputTokens: jsonUsageValue(usage.outputTokens, true), estimatedCostUsd: jsonUsageValue(usage.estimatedCostUsd, false) }
}

/** Finds only a completed archived wait on the exact latest owner-loaded root Step. */
export async function recoverCanonicalArchivedWaitControl(input: {
  readonly identity: TurnExecutionIdentity
  readonly steps: readonly Row[]
  readonly items: readonly Row[]
  readonly events: readonly Row[]
  readonly observations: readonly Observation[]
  readonly snapshot: Parameters<typeof hasResolvedWaitOutcome>[0]
  readonly reader?: DurableWaitControlReader
  readonly now: Date
}): Promise<RecoveredArchivedWaitControl | undefined> {
  const { identity } = input
  if (identity.kind !== "turn" || identity.taskId !== identity.rootTaskId) return undefined
  const step = input.steps[input.steps.length - 1]
  if (!step || typeof step.id !== "string" || !step.id || !scopedTask(step.taskId, identity.rootTaskId)
    || (step.status !== "running" && step.status !== "waiting_for_tool")) return undefined
  const stepItems = input.items.filter(item => item.stepId === step.id && scopedTask(item.taskId, identity.rootTaskId))
  const callItems = stepItems.filter(item => item.type === "tool_call")
  const candidates: Array<{ call: Row; result: Row; resultItem: Row; event: Row; input: unknown; callId: string; toolName: string }> = []
  for (const callItem of callItems) {
    const call = object(callItem.content), callId = call?.toolCallId, toolName = call?.toolName
    if (!call || typeof callId !== "string" || typeof toolName !== "string" || !["agent.wait", "wait_subagents"].includes(toolName)) continue
    const resultItems = stepItems.filter(item => item.type === "tool_result" && object(item.content)?.toolCallId === callId)
    if (resultItems.length > 1) invalid()
    const resultItem = resultItems[0]
    const result = object(resultItem?.content)
    if (!result || !Object.hasOwn(result, "output") || !object(result.output) || !Object.hasOwn(object(result.output)!, "$ref")) continue
    parseArchivedWaitReference(result.output)
    if (callItem.status !== "completed" || call.status !== "completed" || resultItem?.status !== "completed") invalid()
    const completionEvents = input.events.filter(candidate => candidate.type === "tool_call.completed" && candidate.correlationId === callId
      && candidate.itemId === callItem.id && candidate.idempotencyKey === `turn:${identity.turnId}:event:tool-finished:${callId}`)
    if (completionEvents.length !== 1) invalid()
    const event = completionEvents[0]
    const eventData = payload(event?.payload)
    if (!event || event.userId !== identity.userId || event.sessionId !== identity.sessionId || event.turnId !== identity.turnId
      || event.taskId !== identity.rootTaskId || event.itemId !== callItem.id || event.actor !== "orchestrator"
      || event.idempotencyKey !== `turn:${identity.turnId}:event:tool-finished:${callId}`
      || eventData?.toolCallId !== callId || eventData?.taskId !== identity.rootTaskId
      || eventData.toolName !== toolName || eventData.status !== "completed") invalid()
    const matchingObservations = input.observations.filter(candidate => candidate.id === `tool-result:${callId}`)
    if (matchingObservations.length !== 1) invalid()
    const observation = matchingObservations[0]
    const observed = object(observation?.content)
    if (!observed || observed.toolCallId !== callId || observed.toolName !== toolName || observed.status !== "completed"
      || !isDeepStrictEqual(observed.input, call.input) || !isDeepStrictEqual(observed.output, result.output)) invalid()
    candidates.push({ call, result, resultItem: resultItem!, event, input: call.input, callId, toolName })
  }
  if (candidates.length === 0) return undefined
  if (candidates.length !== 1) invalid()
  const candidate = candidates[0]!
  const control = await lookupArchivedWaitControl({
    toolName: candidate.toolName, input: candidate.input, stepId: String(step.id), output: candidate.result.output,
    identity, now: input.now, reader: input.reader, stepAdmission: "restored_inflight_root", allowInterruptedRecovery: true,
  })
  if (!control) invalid()
  if (control.status === "interrupted") {
    if (!hasResolvedWaitOutcome(input.snapshot, control.waitId, candidate.input, "interrupted")) invalid()
    return undefined
  }
  if (hasResolvedWaitOutcome(input.snapshot, control.waitId, candidate.input)) return undefined
  const completionEvents = input.events.filter(event => event.type === "step.completed" && event.correlationId === step.id)
  if (completionEvents.length > 1) invalid()
  const completion = completionEvents[0]
  const completionPayload = payload(completion?.payload)
  let toolCallCount = callItems.length
  if (completion) {
    if (step.status !== "waiting_for_tool" || !scopedTask(completion.taskId, identity.rootTaskId)
      || completionPayload?.stepId !== step.id || completionPayload.status !== "waiting_for_dependency"
      || !scopedTask(completionPayload.taskId, identity.rootTaskId)
      || !Number.isSafeInteger(completionPayload.toolCallCount) || Number(completionPayload.toolCallCount) !== callItems.length) invalid()
    toolCallCount = Number(completionPayload.toolCallCount)
  }
  const usage = modelUsage(input.events, String(step.id), identity)
  const stepUsage = { inputTokens: persistedNumber(step.inputTokens, true), outputTokens: persistedNumber(step.outputTokens, true), estimatedCostUsd: persistedNumber(step.estimatedCostUsd) }
  const stepHasZeroUsage = stepUsage.inputTokens === 0 && stepUsage.outputTokens === 0 && stepUsage.estimatedCostUsd === 0
  const stepMatchesUsage = stepUsage.inputTokens === usage.inputTokens && stepUsage.outputTokens === usage.outputTokens && stepUsage.estimatedCostUsd === usage.estimatedCostUsd
  if (step.status === "waiting_for_tool" && !stepMatchesUsage || step.status === "running" && !stepHasZeroUsage && !stepMatchesUsage) invalid()
  const recoveredUsage = step.status === "running" && stepHasZeroUsage ? usage : stepUsage
  return {
    ...control, stepId: String(step.id), stepStatus: step.status,
    finishReason: persistedText(step.finishReason), errorCode: persistedText(step.errorCode),
    ...recoveredUsage, toolCallCount, stepCompletionRecorded: !!completion,
  }
}

export function recoverCanonicalArchivedWaitControlForRoot(input: {
  readonly lease: TurnLease; readonly rootTaskId: string; readonly steps: readonly Row[]; readonly items: readonly Row[]
  readonly events: readonly Row[]; readonly observations: readonly Observation[]; readonly snapshot: Parameters<typeof hasResolvedWaitOutcome>[0]
  readonly reader?: DurableWaitControlReader; readonly now: Date
}): Promise<RecoveredArchivedWaitControl | undefined> {
  const { lease, rootTaskId } = input
  return recoverCanonicalArchivedWaitControl({
    ...input, identity: { kind: "turn", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
      taskId: rootTaskId, rootTaskId, ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt },
  })
}
