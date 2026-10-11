import { parseModelCompletedReceipt } from "./turns/model-completed-receipt.js"
import type { TurnResumeState } from "./turns/turn-engine-types.js"
import type { RecoveredArchivedWaitControl } from "./turns/turn-execution-wait.js"

type Row = Record<string, unknown>
type Usage = { inputTokens: number; outputTokens: number; estimatedCostUsd: number }
type Scope = { readonly userId: string; readonly sessionId: string; readonly turnId: string; readonly rootTaskId: string }
const usageZero = (): Usage => ({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
function invalid(): never { throw new Error("archived_wait_accounting_invalid") }
function exactKeys(value: Row, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
    && expected.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && "value" in descriptor })
}
function sequence(value: unknown): bigint | null {
  try { const parsed = BigInt(String(value)); return parsed > 0n ? parsed : null } catch { return null }
}
function eventScope(event: Row, type: string, stepId: string, scope: Scope, key: string, itemId: string | null = null): boolean {
  return event.type === type && event.correlationId === stepId && event.idempotencyKey === key
    && event.userId === scope.userId && event.sessionId === scope.sessionId && event.turnId === scope.turnId
    && event.taskId === scope.rootTaskId && event.actor === "orchestrator" && event.itemId === itemId
    && typeof event.id === "string" && event.id.length > 0
}

const EVIDENCE_RECOVERY_KEY = "evidence-recovery-once"
function closedEvidenceRecoveryStep(step: Row, stepId: string, marker: Row, events: readonly Row[], scope: Scope): boolean {
  if (step.status !== "completed" || step.taskId !== scope.rootTaskId || step.errorCode !== null) return false
  const matching = (type: string) => events.filter(event => event.type === type && event.correlationId === stepId)
  const starts = matching("model.started"), completions = matching("model.completed"), usages = matching("model.usage"), closes = matching("step.completed")
  if (starts.length !== 1 || completions.length !== 1 || usages.length !== 1 || closes.length !== 1) return false
  const started = starts[0]!, completed = completions[0]!, usageEvent = usages[0]!, closed = closes[0]!
  const startPayload = object(started.payload), usagePayload = object(usageEvent.payload), usage = usagePayload && usagePayload.usage
  const receipt = parseModelCompletedReceipt(completed.payload), closePayload = object(closed.payload)
  const startSequence = sequence(started.sequence), modelSequence = sequence(completed.sequence), usageSequence = sequence(usageEvent.sequence)
  const markerSequence = sequence(marker.sequence), closeSequence = sequence(closed.sequence)
  if (!eventScope(started, "model.started", stepId, scope, `turn:${scope.turnId}:event:model-started:${stepId}`)
    || !eventScope(completed, "model.completed", stepId, scope, `turn:${scope.turnId}:event:model-completed:${stepId}`)
    || !eventScope(usageEvent, "model.usage", stepId, scope, `turn:${scope.turnId}:event:model-usage:${stepId}`)
    || !eventScope(closed, "step.completed", stepId, scope, `turn:${scope.turnId}:event:step-completed:${stepId}`)
    || !startPayload || !exactKeys(startPayload, ["provider", "model", "taskId"]) || startPayload.taskId !== scope.rootTaskId
    || typeof startPayload.provider !== "string" || !startPayload.provider || typeof startPayload.model !== "string" || !startPayload.model
    || !receipt || receipt.taskId !== scope.rootTaskId || receipt.provider !== startPayload.provider || receipt.model !== startPayload.model
    || receipt.toolCallCount !== 0 || completed.causationId !== started.id || usageEvent.causationId !== completed.id
    || !usagePayload || !exactKeys(usagePayload, ["provider", "model", "usage", "taskId"])
    || usagePayload.taskId !== scope.rootTaskId || usagePayload.provider !== startPayload.provider || usagePayload.model !== startPayload.model
    || !closePayload || !exactKeys(closePayload, ["stepId", "status", "taskId"])
    || closePayload.stepId !== stepId || closePayload.status !== "completed" || closePayload.taskId !== scope.rootTaskId
    || closed.causationId !== marker.id || startSequence === null || modelSequence === null || usageSequence === null
    || markerSequence === null || closeSequence === null
    || startSequence >= modelSequence || modelSequence >= usageSequence || usageSequence >= markerSequence || markerSequence >= closeSequence) return false
  const expected = usage === null ? usageZero() : object(usage)
  if (!expected || (usage !== null && (!exactKeys(expected, ["inputTokens", "outputTokens", "estimatedCostUsd"])
    || !Number.isSafeInteger(expected.inputTokens) || Number(expected.inputTokens) < 0
    || !Number.isSafeInteger(expected.outputTokens) || Number(expected.outputTokens) < 0
    || typeof expected.estimatedCostUsd !== "number" || !Number.isFinite(expected.estimatedCostUsd) || expected.estimatedCostUsd < 0))) return false
  return Number(step.inputTokens) === Number(expected.inputTokens) && Number(step.outputTokens) === Number(expected.outputTokens)
    && Number(step.estimatedCostUsd) === Number(expected.estimatedCostUsd)
}

function finalEvidenceRecoveryUsed(events: readonly Row[], steps: readonly Row[], scope: Scope): boolean {
  const prefix = `turn:${scope.turnId}:event:final-rejected:`, suffix = `:${EVIDENCE_RECOVERY_KEY}`
  const markers = events.filter(event => typeof event.idempotencyKey === "string"
    && event.idempotencyKey.startsWith(prefix) && event.idempotencyKey.endsWith(suffix)
    && event.idempotencyKey.length > prefix.length + suffix.length)
  if (markers.length === 0) return false
  if (markers.length !== 1) throw new Error("final_evidence_recovery_marker_invalid")
  const marker = markers[0]!, stepId = marker.correlationId
  const matchingSteps = typeof stepId === "string" ? steps.filter(step => step.id === stepId) : []
  if (typeof stepId !== "string" || !stepId || !eventScope(marker, "final.rejected", stepId, scope,
      `turn:${scope.turnId}:event:final-rejected:${stepId}:${EVIDENCE_RECOVERY_KEY}`)
    || sequence(marker.sequence) === null || matchingSteps.length !== 1 || matchingSteps[0]?.taskId !== scope.rootTaskId) {
    throw new Error("final_evidence_recovery_marker_invalid")
  }
  const payload = object(marker.payload)
  if (!payload || !exactKeys(payload, ["code", "blocker", "feedback", "taskId"])
    || payload.code !== "evidence_missing" || payload.blocker !== "No verifiable evidence is attached to the candidate final"
    || payload.feedback !== "Attach verified business or tool evidence before claiming completion" || payload.taskId !== scope.rootTaskId) {
    throw new Error("final_evidence_recovery_marker_invalid")
  }
  if (!closedEvidenceRecoveryStep(matchingSteps[0]!, stepId, marker, events, scope)) {
    throw new Error("final_evidence_recovery_marker_invalid")
  }
  return true
}

/** Returns only a server-closed waiting Step's full emitted batch count. */
function closedWaitBatchCount(step: Row, items: readonly Row[], events: readonly Row[], scope: Scope): number | undefined {
  if (step.status !== "waiting_for_tool" || typeof step.id !== "string" || !step.id || step.taskId != null && step.taskId !== scope.rootTaskId) return undefined
  const stepId = step.id, key = `turn:${scope.turnId}:event:step-completed:${stepId}`
  const completions = events.filter(event => event.type === "step.completed" && event.correlationId === stepId)
  if (completions.length === 0) return undefined
  if (completions.length !== 1 || !eventScope(completions[0]!, "step.completed", stepId, scope, key)) invalid()
  const completed = completions[0]!, completedPayload = object(completed.payload), completedSequence = sequence(completed.sequence)
  const nativeGateWait = !!completedPayload && exactKeys(completedPayload, ["stepId", "status", "taskId"])
  if (!completedPayload || (!nativeGateWait && !exactKeys(completedPayload, ["stepId", "status", "toolCallCount", "taskId"]))
    || completedPayload.stepId !== stepId || completedPayload.status !== "waiting_for_dependency"
    || completedPayload.taskId !== scope.rootTaskId || (!nativeGateWait && (!Number.isSafeInteger(completedPayload.toolCallCount)
      || Number(completedPayload.toolCallCount) < 0)) || completedSequence === null) invalid()
  const fullCount = nativeGateWait ? 0 : Number(completedPayload.toolCallCount)
  const calls = items.filter(item => item.stepId === stepId && item.type === "tool_call")
  const results = items.filter(item => item.stepId === stepId && item.type === "tool_result")
  if (nativeGateWait && (calls.length !== 0 || results.length !== 0)) invalid()
  if (fullCount < calls.length || calls.some(item => (item.taskId != null && item.taskId !== scope.rootTaskId) || item.status !== "completed")) invalid()

  const startedRows = events.filter(event => event.type === "model.started" && event.correlationId === stepId)
  const completedRows = events.filter(event => event.type === "model.completed" && event.correlationId === stepId)
  const usageRows = events.filter(event => event.type === "model.usage" && event.correlationId === stepId)
  if (startedRows.length !== 1 || completedRows.length !== 1 || usageRows.length !== 1) invalid()
  const started = startedRows[0]!, done = completedRows[0]!, usageEvent = usageRows[0]!
  if (!eventScope(started, "model.started", stepId, scope, `turn:${scope.turnId}:event:model-started:${stepId}`)
    || !eventScope(done, "model.completed", stepId, scope, `turn:${scope.turnId}:event:model-completed:${stepId}`)
    || !eventScope(usageEvent, "model.usage", stepId, scope, `turn:${scope.turnId}:event:model-usage:${stepId}`)) invalid()
  const startedPayload = object(started.payload), doneReceipt = parseModelCompletedReceipt(done.payload), usagePayload = object(usageEvent.payload)
  if (!startedPayload || !exactKeys(startedPayload, ["provider", "model", "taskId"]) || startedPayload.taskId !== scope.rootTaskId
    || typeof startedPayload.provider !== "string" || typeof startedPayload.model !== "string"
    || !doneReceipt || doneReceipt.taskId !== scope.rootTaskId || doneReceipt.provider !== startedPayload.provider || doneReceipt.model !== startedPayload.model
    || doneReceipt.toolCallCount !== undefined && doneReceipt.toolCallCount !== fullCount
    || done.causationId !== started.id || usageEvent.causationId !== done.id) invalid()
  if (!usagePayload || !exactKeys(usagePayload, ["provider", "model", "usage", "taskId"])
    || usagePayload.taskId !== scope.rootTaskId || usagePayload.provider !== startedPayload.provider || usagePayload.model !== startedPayload.model) invalid()
  const startedSequence = sequence(started.sequence), doneSequence = sequence(done.sequence), usageSequence = sequence(usageEvent.sequence)
  if (startedSequence === null || doneSequence === null || usageSequence === null
    || startedSequence >= doneSequence || doneSequence >= usageSequence || usageSequence >= completedSequence) invalid()
  const usageValue = usagePayload.usage
  if (usageValue !== null) {
    const usage = object(usageValue)
    if (!usage || !exactKeys(usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])
      || !Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0
      || !Number.isSafeInteger(usage.outputTokens) || Number(usage.outputTokens) < 0
      || typeof usage.estimatedCostUsd !== "number" || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0) invalid()
  }

  const orderedReceipts: Array<{ readonly toolName: string; readonly sequence: bigint }> = []
  const ownedCallIds = new Set<string>()
  for (const item of calls) {
    const call = object(item.content), callId = call?.toolCallId, toolName = call?.toolName, status = call?.status
    if (typeof item.id !== "string" || !item.id || typeof callId !== "string" || !callId || typeof toolName !== "string" || !toolName
      || ownedCallIds.has(callId) || (status !== "completed" && status !== "failed" && status !== "cancelled")) invalid()
    ownedCallIds.add(callId)
    const resultRows = items.filter(result => result.stepId === stepId && result.type === "tool_result"
      && (result.taskId == null || result.taskId === scope.rootTaskId)
      && object(result.content)?.toolCallId === callId)
    if (resultRows.length !== 1 || resultRows[0]?.status !== "completed") invalid()
    const receipts = events.filter(event => (event.type === "tool_call.completed" || event.type === "tool_call.failed")
      && event.correlationId === callId && event.itemId === item.id)
    if (receipts.length !== 1 || receipts[0]!.type !== (status === "completed" ? "tool_call.completed" : "tool_call.failed")
      || !eventScope(receipts[0]!, status === "completed" ? "tool_call.completed" : "tool_call.failed", callId, scope,
        `turn:${scope.turnId}:event:tool-finished:${callId}`, item.id)) invalid()
    const receiptPayload = object(receipts[0]!.payload), receiptSequence = sequence(receipts[0]!.sequence)
    if (!receiptPayload || receiptPayload.toolCallId !== callId || receiptPayload.toolName !== toolName || receiptPayload.status !== status
      || receiptPayload.taskId !== scope.rootTaskId || receiptSequence === null) invalid()
    orderedReceipts.push({ toolName, sequence: receiptSequence })
  }
  if (results.length !== calls.length || results.some(result => {
    const resultCallId = object(result.content)?.toolCallId
    return result.status !== "completed" || (result.taskId != null && result.taskId !== scope.rootTaskId)
      || typeof resultCallId !== "string" || !ownedCallIds.has(resultCallId)
  })) invalid()
  orderedReceipts.sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0)
  // Native verification can suspend the Step without emitting a tool batch. Its
  // exact three-key completion is already represented by persisted Step usage;
  // it must not be interpreted as an archived-tool suffix.
  if (nativeGateWait) return undefined
  if (orderedReceipts.length === 0) invalid()
  let previousReceiptSequence = usageSequence
  for (const receipt of orderedReceipts) {
    if (receipt.sequence <= previousReceiptSequence || receipt.sequence >= completedSequence) invalid()
    previousReceiptSequence = receipt.sequence
  }
  if (!["agent.wait", "wait_subagents"].includes(orderedReceipts[orderedReceipts.length - 1]!.toolName)) invalid()
  return fullCount
}

/** Rebuilds resume counters, retaining archived-wait tails only from exact server receipts. */
export function buildCanonicalTurnResumeState(input: {
  readonly last?: Row; readonly maxOrdinal: number | null; readonly steps: readonly Row[]
  readonly persistedToolCallCount: number; readonly items: readonly Row[]; readonly events: readonly Row[]; readonly scope: Scope
  readonly recoveredWaitControl?: RecoveredArchivedWaitControl
}): TurnResumeState | undefined {
  const evidenceRecoveryUsed = finalEvidenceRecoveryUsed(input.events, input.steps, input.scope)
  if (!input.last && input.maxOrdinal === null) return undefined
  const usage = input.steps.reduce<Usage>((total, step) => ({
    inputTokens: total.inputTokens + Number(step.inputTokens ?? 0), outputTokens: total.outputTokens + Number(step.outputTokens ?? 0),
    estimatedCostUsd: total.estimatedCostUsd + Number(step.estimatedCostUsd ?? 0),
  }), usageZero())
  let toolCallCount = input.persistedToolCallCount
  const closedCounts = new Map<string, number>()
  for (const step of input.steps) {
    const count = closedWaitBatchCount(step, input.items, input.events, input.scope)
    if (count !== undefined && typeof step.id === "string") {
      const prefix = input.items.filter(item => item.stepId === step.id && item.type === "tool_call").length
      toolCallCount += count - prefix
      closedCounts.set(step.id, count)
    }
  }
  const control = input.recoveredWaitControl
  if (control) {
    const missing = control.toolCallCount - control.persistedToolCallCount
    if (!Number.isSafeInteger(missing) || missing < 0) invalid()
    if (control.stepCompletionRecorded) {
      if (closedCounts.get(control.stepId) !== control.toolCallCount) invalid()
    } else toolCallCount += missing
    usage.inputTokens += control.usageDelta.inputTokens
    usage.outputTokens += control.usageDelta.outputTokens
    usage.estimatedCostUsd += control.usageDelta.estimatedCostUsd
  }
  return {
    nextOrdinal: (input.maxOrdinal ?? Number(input.last?.ordinal)) + 1, stepCount: input.steps.length, toolCallCount,
    ...(evidenceRecoveryUsed ? { finalEvidenceRecoveryUsed: true } : {}),
    inputThroughSequence: BigInt(String(input.last?.inputThroughSequence ?? 0)),
    consumedInputIds: Array.isArray(input.last?.consumedInputIds) ? input.last.consumedInputIds.filter((id): id is string => typeof id === "string") : [],
    usage,
  }
}
