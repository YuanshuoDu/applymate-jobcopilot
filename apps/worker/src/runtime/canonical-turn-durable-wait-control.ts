import { isDeepStrictEqual } from "node:util"
import type { DurableWaitControlReader } from "./tools/coordination-types.js"
import { lookupArchivedWaitControl, parseArchivedWaitReference } from "./turns/durable-wait-control.js"
import { hasResolvedWaitOutcome, type RecoveredArchivedWaitControl } from "./turns/turn-execution-wait.js"
import type { TurnExecutionIdentity } from "./turns/turn-execution-types.js"
import { TurnEngineError } from "./turns/turn-engine-types.js"
import type { TurnLease } from "./turns/lease.js"
import { parseModelCompletedReceipt } from "./turns/model-completed-receipt.js"

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
type ModelUsageReceipt = { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCostUsd: number; readonly sequence: bigint; readonly toolCallCount?: number }
function modelUsage(events: readonly Row[], stepId: string, identity: TurnExecutionIdentity): ModelUsageReceipt {
  const { rootTaskId, turnId } = identity
  const rows = events.filter(event => ["model.started", "model.completed", "model.usage"].includes(String(event.type)) && event.correlationId === stepId)
  const started = rows.filter(event => event.type === "model.started"), completed = rows.filter(event => event.type === "model.completed"), usages = rows.filter(event => event.type === "model.usage")
  const start = started[0], done = completed[0], event = usages[0], startBody = payload(start?.payload), doneBody = payload(done?.payload)
  const doneReceipt = parseModelCompletedReceipt(doneBody), body = payload(event?.payload)
  if (started.length !== 1 || completed.length !== 1 || usages.length !== 1 || !start || !done || !event
    || ![start, done, event].every(row => row.userId === identity.userId && row.sessionId === identity.sessionId && row.turnId === turnId
      && row.taskId === rootTaskId && row.actor === "orchestrator" && row.itemId === null && typeof row.id === "string" && !!row.id)
    || start.idempotencyKey !== "turn:" + turnId + ":event:model-started:" + stepId
    || done.idempotencyKey !== "turn:" + turnId + ":event:model-completed:" + stepId
    || event.idempotencyKey !== "turn:" + turnId + ":event:model-usage:" + stepId
    || !exactKeys(startBody, ["provider", "model", "taskId"]) || startBody.taskId !== rootTaskId
    || !boundedString(startBody.provider, 128) || !boundedString(startBody.model, 128)
    || !doneReceipt || doneReceipt.taskId !== rootTaskId || !boundedString(doneReceipt.provider, 128) || !boundedString(doneReceipt.model, 128)
    || !exactKeys(body, ["provider", "model", "usage", "taskId"]) || body.taskId !== rootTaskId
    || body.provider !== startBody.provider || body.model !== startBody.model
    || body.provider !== doneReceipt.provider || body.model !== doneReceipt.model
    || done.causationId !== start.id || event.causationId !== done.id) invalid()
  const startSequence = eventSequence(start.sequence), doneSequence = eventSequence(done.sequence), usageSequence = eventSequence(event.sequence)
  if (startSequence === null || doneSequence === null || usageSequence === null || startSequence >= doneSequence || doneSequence >= usageSequence) invalid()
  if (body.usage === null) return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, sequence: usageSequence!, ...(doneReceipt.toolCallCount === undefined ? {} : { toolCallCount: doneReceipt.toolCallCount }) }
  const usage = object(body.usage)
  if (!exactKeys(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])) invalid()
  return { inputTokens: jsonUsageValue(usage.inputTokens, true), outputTokens: jsonUsageValue(usage.outputTokens, true), estimatedCostUsd: jsonUsageValue(usage.estimatedCostUsd, false), sequence: usageSequence!, ...(doneReceipt.toolCallCount === undefined ? {} : { toolCallCount: doneReceipt.toolCallCount }) }
}

function completedPrefix(callItems: readonly Row[], stepItems: readonly Row[], events: readonly Row[], identity: TurnExecutionIdentity, lastCallItem: Row,
  usageSequence: bigint, receiptCeiling: bigint, requireExactTask: boolean): void {
  const ordered: Array<{ item: Row; sequence: bigint }> = []
  for (const item of callItems) {
    const call = object(item.content), id = call?.toolCallId, name = call?.toolName, status = call?.status
    if (typeof item.id !== "string" || !item.id || (requireExactTask ? item.taskId !== identity.rootTaskId : !scopedTask(item.taskId, identity.rootTaskId))
      || item.status !== "completed" || typeof id !== "string" || typeof name !== "string"
      || (status !== "completed" && status !== "failed" && status !== "cancelled")) invalid()
    const resultItems = stepItems.filter(result => (requireExactTask ? result.taskId === identity.rootTaskId : scopedTask(result.taskId, identity.rootTaskId))
      && result.type === "tool_result" && object(result.content)?.toolCallId === id)
    if (resultItems.length !== 1 || resultItems[0]?.status !== "completed") invalid()
    const eventType = status === "completed" ? "tool_call.completed" : "tool_call.failed"
    const receipts = events.filter(event => (event.type === "tool_call.completed" || event.type === "tool_call.failed")
      && event.correlationId === id && event.itemId === item.id)
    const event = receipts[0], data = payload(event?.payload)
    const receiptSequence = eventSequence(event?.sequence)
    if (receipts.length !== 1 || !event || event.type !== eventType || event.userId !== identity.userId || event.sessionId !== identity.sessionId
      || event.turnId !== identity.turnId || event.taskId !== identity.rootTaskId || event.actor !== "orchestrator"
      || event.idempotencyKey !== `turn:${identity.turnId}:event:tool-finished:${id}`
      || data?.toolCallId !== id || data.toolName !== name || data.status !== status || data.taskId !== identity.rootTaskId
      || receiptSequence === null) invalid()
    ordered.push({ item, sequence: receiptSequence })
  }
  ordered.sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0)
  if (ordered.length === 0) invalid()
  let previousSequence = usageSequence
  for (const receipt of ordered) {
    if (receipt.sequence <= previousSequence || receipt.sequence > receiptCeiling) invalid()
    previousSequence = receipt.sequence
  }
  if (ordered[ordered.length - 1]?.item !== lastCallItem) invalid()
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
  if (!step || typeof step.id !== "string" || !step.id
    || (step.status === "streaming" ? step.taskId !== identity.rootTaskId : !scopedTask(step.taskId, identity.rootTaskId))
    || (step.status !== "streaming" && step.status !== "running" && step.status !== "waiting_for_tool")) return undefined
  const stepItems = input.items.filter(item => item.stepId === step.id && scopedTask(item.taskId, identity.rootTaskId))
  const callItems = stepItems.filter(item => item.type === "tool_call")
  const candidates: Array<{ callItem: Row; call: Row; result: Row; resultItem: Row; event: Row; input: unknown; callId: string; toolName: string }> = []
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
    candidates.push({ callItem, call, result, resultItem: resultItem!, event, input: call.input, callId, toolName })
  }
  if (candidates.length === 0) return undefined
  if (candidates.length !== 1) invalid()
  const candidate = candidates[0]!
  const usage = modelUsage(input.events, String(step.id), identity)
  const waitSequence = eventSequence(candidate.event.sequence)
  if (waitSequence === null || usage.sequence >= waitSequence) invalid()
  if (step.status === "streaming" && (step.taskId !== identity.rootTaskId || usage.toolCallCount === undefined)) invalid()
  const completionEvents = input.events.filter(event => event.type === "step.completed" && event.correlationId === step.id)
  if (completionEvents.length > 1) invalid()
  const completion = completionEvents[0]
  const completionPayload = payload(completion?.payload)
  const completionSequence = completion ? eventSequence(completion.sequence) : null
  if (completion && (step.status !== "waiting_for_tool" || completion.userId !== identity.userId || completion.sessionId !== identity.sessionId
    || completion.turnId !== identity.turnId || completion.taskId !== identity.rootTaskId || completion.actor !== "orchestrator"
    || completion.itemId !== null || completion.idempotencyKey !== `turn:${identity.turnId}:event:step-completed:${step.id}`
    || typeof completion.id !== "string" || !completion.id || !exactKeys(completionPayload, ["stepId", "status", "toolCallCount", "taskId"])
    || completionPayload.stepId !== step.id || completionPayload.status !== "waiting_for_dependency"
    || completionPayload.taskId !== identity.rootTaskId || completionSequence === null || waitSequence >= completionSequence
    || !Number.isSafeInteger(completionPayload.toolCallCount) || Number(completionPayload.toolCallCount) < callItems.length
    || (usage.toolCallCount !== undefined && Number(completionPayload.toolCallCount) !== usage.toolCallCount))) invalid()
  if ((step.status === "streaming" || step.status === "running") && completion) invalid()
  const toolCallCount = completion ? Number(completionPayload!.toolCallCount) : usage.toolCallCount ?? callItems.length
  if (!Number.isSafeInteger(toolCallCount) || toolCallCount < callItems.length || (step.status === "streaming" && toolCallCount === 0)) invalid()
  completedPrefix(callItems, stepItems, input.events, identity, candidate.callItem, usage.sequence, completionSequence ?? waitSequence, step.status === "streaming")
  const stepUsage = { inputTokens: persistedNumber(step.inputTokens, true), outputTokens: persistedNumber(step.outputTokens, true), estimatedCostUsd: persistedNumber(step.estimatedCostUsd) }
  const stepHasZeroUsage = stepUsage.inputTokens === 0 && stepUsage.outputTokens === 0 && stepUsage.estimatedCostUsd === 0
  const stepMatchesUsage = stepUsage.inputTokens === usage.inputTokens && stepUsage.outputTokens === usage.outputTokens && stepUsage.estimatedCostUsd === usage.estimatedCostUsd
  if (step.status === "waiting_for_tool" && !stepMatchesUsage
    || (step.status === "running" || step.status === "streaming") && !stepHasZeroUsage && !stepMatchesUsage) invalid()
  const usageDelta = (step.status === "running" || step.status === "streaming") && stepHasZeroUsage
    ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd }
    : { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  const control = await lookupArchivedWaitControl({
    toolName: candidate.toolName, input: candidate.input, stepId: String(step.id), output: candidate.result.output,
    identity, now: input.now, reader: input.reader, stepAdmission: "restored_inflight_root", allowInterruptedRecovery: true,
  })
  if (!control) invalid()
  const canonicalOutcomeResolved = control.status === "interrupted"
    ? hasResolvedWaitOutcome(input.snapshot, control.waitId, candidate.input, "interrupted")
    : control.status !== "waiting" && hasResolvedWaitOutcome(input.snapshot, control.waitId, candidate.input, control.status)
  if (control.status === "interrupted" && !canonicalOutcomeResolved) invalid()
  if (control.status === "waiting" && hasResolvedWaitOutcome(input.snapshot, control.waitId, candidate.input)) invalid()
  return {
    ...control, stepId: String(step.id), stepStatus: step.status,
    finishReason: persistedText(step.finishReason), errorCode: persistedText(step.errorCode),
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd,
    usageDelta, toolCallCount, persistedToolCallCount: callItems.length,
    stepCompletionRecorded: !!completion, canonicalOutcomeResolved,
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
