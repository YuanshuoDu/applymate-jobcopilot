import { parseCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE, cognitiveAgendaReceiptIdempotencyKey } from "./cognitive-agenda-receipt.js"
import { parseModelCompletedReceipt } from "./model-completed-receipt.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA } from "./task-graph-terminal-assessment.js"
import { taskGraphDenialProgressFor } from "./task-graph-denial-progress.js"
import type { TaskGraphDenialProgress } from "./turn-execution-types.js"

type Row = Record<string, unknown>
type Scope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string }>
type ResumeInput = Readonly<{ steps: readonly Row[]; items: readonly Row[]; events: readonly Row[]; scope: Scope }>
type QualifyingDenial = Omit<TaskGraphDenialProgress, "count"> & { firstSequence: bigint; closeSequence: bigint }
export const TASK_GRAPH_DENIAL_CHECKPOINT_EVENT_TYPE = "agent.plan.denial_checkpoint"
const CHECKPOINT_EVENT = TASK_GRAPH_DENIAL_CHECKPOINT_EVENT_TYPE
const FEEDBACK_PREFIX = "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing."
const TOOL_EVENTS = new Set(["tool_call.started", "tool_call.completed", "tool_call.failed"])

function object(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null ? value as Row : null } catch { return null }
}
function exact(value: Row | null, expected: readonly string[]): value is Row {
  if (!value) return false
  const keys = Reflect.ownKeys(value)
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
    && expected.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && "value" in descriptor })
}
function sequence(value: unknown): bigint | null {
  try { const parsed = BigInt(String(value)); return parsed > 0n ? parsed : null } catch { return null }
}
function safeId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}
function eventScope(event: Row, type: string, stepId: string, scope: Scope, key: string): boolean {
  return event.type === type && event.correlationId === stepId && event.idempotencyKey === key
    && event.userId === scope.userId && event.sessionId === scope.sessionId && event.turnId === scope.turnId
    && event.taskId === scope.rootTaskId && event.actor === "orchestrator" && event.itemId === null
    && safeId(event.id)
}
function itemScope(event: Row, type: string, itemId: string, stepId: string, scope: Scope, key: string, correlationId: string): boolean {
  return event.type === type && event.correlationId === correlationId && event.itemId === itemId && event.payload === null
    && event.eventItemType === "reasoning_summary" && event.eventItemStepId === stepId && event.eventItemTaskId === scope.rootTaskId
    && event.idempotencyKey === key && event.userId === scope.userId && event.sessionId === scope.sessionId
    && event.turnId === scope.turnId && event.taskId === scope.rootTaskId && event.actor === "orchestrator" && safeId(event.id)
}
function usage(value: unknown): { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null {
  if (value === null) return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  const row = object(value)
  if (!exact(row, ["inputTokens", "outputTokens", "estimatedCostUsd"]) || !Number.isSafeInteger(row.inputTokens) || Number(row.inputTokens) < 0
    || !Number.isSafeInteger(row.outputTokens) || Number(row.outputTokens) < 0
    || typeof row.estimatedCostUsd !== "number" || !Number.isFinite(row.estimatedCostUsd) || row.estimatedCostUsd < 0) return null
  return { inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), estimatedCostUsd: row.estimatedCostUsd }
}
function sameUsage(step: Row, persisted: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }): boolean {
  const inputTokens = Number(step.inputTokens), outputTokens = Number(step.outputTokens), cost = Number(step.estimatedCostUsd)
  return step.inputTokens !== null && step.inputTokens !== undefined && step.outputTokens !== null && step.outputTokens !== undefined
    && step.estimatedCostUsd !== null && step.estimatedCostUsd !== undefined
    && Number.isSafeInteger(inputTokens) && inputTokens === persisted.inputTokens
    && Number.isSafeInteger(outputTokens) && outputTokens === persisted.outputTokens
    && Number.isFinite(cost) && cost === persisted.estimatedCostUsd
}
function checkpointPayload(marker: Row, stepId: string, scope: Scope): { graphRevision: number; verificationDigest: string } | null {
  const value = object(marker.payload)
  if (!eventScope(marker, CHECKPOINT_EVENT, stepId, scope, `turn:${scope.turnId}:event:task-graph-denial-checkpoint:${stepId}`)
    || !exact(value, ["schemaVersion", "taskId", "stepId", "graphRevision", "verificationDigest"])
    || value.schemaVersion !== TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA || value.taskId !== scope.rootTaskId || value.stepId !== stepId
    || !Number.isSafeInteger(value.graphRevision) || Number(value.graphRevision) < 1
    || typeof value.verificationDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.verificationDigest)) return null
  return { graphRevision: Number(value.graphRevision), verificationDigest: value.verificationDigest }
}

function hasToolEventInStep(input: ResumeInput, stepId: string, first: bigint, last: bigint): boolean {
  return input.events.some(event => {
    if (!TOOL_EVENTS.has(String(event.type))) return false
    if (event.correlationId === stepId) return true
    if (event.sessionId !== input.scope.sessionId || event.turnId !== input.scope.turnId
      || (event.taskId != null && event.taskId !== input.scope.rootTaskId)) return false
    const eventSequence = sequence(event.sequence)
    if (eventSequence === null) return true
    if (eventSequence < first || eventSequence > last) return false
    // The canonical query supplies the session owner as userId; any in-window event makes this non-zero-tool.
    return true
  })
}

function hasAmbiguousStepEvents(input: ResumeInput, stepId: string): boolean {
  const related = input.events.filter(event => event.correlationId === stepId || event.eventItemStepId === stepId)
  const ids = new Set<string>(), sequences = new Set<bigint>()
  for (const event of related) {
    const eventSequence = sequence(event.sequence)
    if (!safeId(event.id) || eventSequence === null || ids.has(event.id) || sequences.has(eventSequence)) return true
    ids.add(event.id); sequences.add(eventSequence)
  }
  return false
}

function qualifyingStep(input: ResumeInput, step: Row): QualifyingDenial | null {
  const stepId = step.id
  if (!safeId(stepId) || !Number.isSafeInteger(step.ordinal) || Number(step.ordinal) < 0
    || !Number.isSafeInteger(step.attempt) || Number(step.attempt) < 1
    || step.status !== "completed" || step.taskId !== input.scope.rootTaskId || step.errorCode !== null) return null
  if (input.items.some(item => item.stepId === stepId && (item.type === "tool_call" || item.type === "tool_result"))) return null
  if (hasAmbiguousStepEvents(input, stepId)) return null
  const events = input.events.filter(event => event.correlationId === stepId)
  if (events.some(event => event.type === "tool_call.started" || event.type === "tool_call.completed" || event.type === "tool_call.failed")) return null
  const matching = (type: string) => events.filter(event => event.type === type)
  const starts = matching("model.started"), completions = matching("model.completed"), usages = matching("model.usage")
  const agendas = matching(COGNITIVE_AGENDA_EVENT_TYPE), markers = matching(CHECKPOINT_EVENT)
  const denials = matching("final.rejected"), closes = matching("step.completed")
  if ([starts.length, completions.length, usages.length, agendas.length, markers.length, denials.length, closes.length].some(count => count !== 1)) return null
  const [started, completed, usageEvent, agendaEvent, marker, rejected, closed] = [starts[0]!, completions[0]!, usages[0]!, agendas[0]!, markers[0]!, denials[0]!, closes[0]!]
  const markerInfo = checkpointPayload(marker, stepId, input.scope)
  if (!markerInfo) return null
  const key = `turn:${input.scope.turnId}:event:`
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(stepId)
  if (!eventScope(started, "model.started", stepId, input.scope, `${key}model-started:${stepId}`)
    || !eventScope(completed, "model.completed", stepId, input.scope, `${key}model-completed:${stepId}`)
    || !eventScope(usageEvent, "model.usage", stepId, input.scope, `${key}model-usage:${stepId}`)
    || !agendaKey || !eventScope(agendaEvent, COGNITIVE_AGENDA_EVENT_TYPE, stepId, input.scope, `${key}${agendaKey}`)
    || !eventScope(rejected, "final.rejected", stepId, input.scope, `${key}final-rejected:${stepId}`)
    || !eventScope(closed, "step.completed", stepId, input.scope, `${key}step-completed:${stepId}`)) return null
  const startPayload = object(started.payload), usagePayload = object(usageEvent.payload), rejection = object(rejected.payload), closePayload = object(closed.payload)
  const model = parseModelCompletedReceipt(completed.payload), storedUsage = usage(usagePayload?.usage)
  if (!exact(startPayload, ["provider", "model", "taskId"]) || startPayload.taskId !== input.scope.rootTaskId
    || typeof startPayload.provider !== "string" || !startPayload.provider || typeof startPayload.model !== "string" || !startPayload.model
    || !model || model.taskId !== input.scope.rootTaskId || model.provider !== startPayload.provider || model.model !== startPayload.model || model.toolCallCount !== 0
    || !exact(usagePayload, ["provider", "model", "usage", "taskId"]) || usagePayload.taskId !== input.scope.rootTaskId
    || usagePayload.provider !== startPayload.provider || usagePayload.model !== startPayload.model || !storedUsage || !sameUsage(step, storedUsage)
    || !exact(rejection, ["code", "blocker", "feedback", "taskId"]) || rejection.code !== "business_precondition_failed"
    || rejection.blocker !== "task_graph_verification_unverified" || rejection.taskId !== input.scope.rootTaskId
    || typeof rejection.feedback !== "string" || !rejection.feedback.startsWith(FEEDBACK_PREFIX) || rejection.feedback.length > 512
    || !exact(closePayload, ["stepId", "status", "taskId"]) || closePayload.stepId !== stepId
    || closePayload.status !== "completed" || closePayload.taskId !== input.scope.rootTaskId) return null
  const parsedAgenda = parseCognitiveAgendaReceipt(agendaEvent.payload, {
    sessionId: input.scope.sessionId, turnId: input.scope.turnId, taskId: input.scope.rootTaskId, stepId,
  })
  const fence = parsedAgenda?.resumeFence
  let stepSequence: bigint
  try { stepSequence = BigInt(String(step.inputThroughSequence)) } catch { return null }
  const stepIds = Array.isArray(step.consumedInputIds) ? step.consumedInputIds : null
  if (!parsedAgenda || parsedAgenda.planRevision !== markerInfo.graphRevision
    || !fence || !stepIds || fence.inputThroughSequence !== stepSequence.toString()
    || stepIds.length !== fence.consumedInputIds.length || stepIds.some((id, index) => id !== fence.consumedInputIds[index])) return null
  const usageSequence = sequence(usageEvent.sequence)
  if (usageSequence === null) return null
  const itemTypes = new Set(["item.started", "item.delta", "item.completed"])
  const lifecycle = input.events.filter(event => itemTypes.has(String(event.type))
    && (event.correlationId === stepId || event.eventItemStepId === stepId))
  let lifecycleEnd: bigint | null = null
  if (lifecycle.length === 0) {
    if (marker.causationId !== usageEvent.id) return null
  } else {
    const itemIds = new Set(lifecycle.map(event => event.itemId).filter((id): id is string => typeof id === "string"))
    if (lifecycle.length !== 3 || itemIds.size !== 1) return null
    const itemId = [...itemIds][0]!
    const itemStart = lifecycle.find(event => event.type === "item.started")
    const itemDelta = lifecycle.find(event => event.type === "item.delta")
    const itemCompleted = lifecycle.find(event => event.type === "item.completed")
    const deltaPrefix = `turn:${input.scope.turnId}:event:reasoning-delta:${itemId}:`
    const completedPrefix = `turn:${input.scope.turnId}:event:reasoning-completed:${itemId}:`
    const deltaKey = itemDelta?.idempotencyKey, completedKey = itemCompleted?.idempotencyKey
    if (!safeId(itemId) || !itemStart || !itemDelta || !itemCompleted
      || !itemScope(itemStart, "item.started", itemId, stepId, input.scope, `turn:${input.scope.turnId}:event:item-started:${itemId}`, stepId)
      || !itemScope(itemDelta, "item.delta", itemId, stepId, input.scope, `${deltaPrefix}1`, itemId)
      || deltaKey !== `${deltaPrefix}1`
      || !itemScope(itemCompleted, "item.completed", itemId, stepId, input.scope, `${completedPrefix}2`, itemId)
      || completedKey !== `${completedPrefix}2`
      || itemStart.causationId !== usageEvent.id || itemDelta.causationId !== itemStart.id
      || itemCompleted.causationId !== itemDelta.id || marker.causationId !== itemCompleted.id) return null
    const itemStartSeq = sequence(itemStart.sequence), itemDeltaSeq = sequence(itemDelta.sequence), itemCompletedSeq = sequence(itemCompleted.sequence)
    if (itemStartSeq === null || itemDeltaSeq === null || itemCompletedSeq === null
      || itemStartSeq <= usageSequence || itemDeltaSeq <= itemStartSeq || itemCompletedSeq <= itemDeltaSeq) return null
    lifecycleEnd = itemCompletedSeq
  }
  const startSeq = sequence(started.sequence), agendaSeq = sequence(agendaEvent.sequence), modelSeq = sequence(completed.sequence)
  const markerSeq = sequence(marker.sequence), rejectSeq = sequence(rejected.sequence), closeSeq = sequence(closed.sequence)
  const predecessorSeq = lifecycleEnd ?? usageSequence
  if ([startSeq, agendaSeq, modelSeq, usageSequence, markerSeq, rejectSeq, closeSeq].some(value => value === null)
    || predecessorSeq === null || !(agendaSeq! < startSeq! && startSeq! < modelSeq! && modelSeq! < usageSequence!
      && predecessorSeq < markerSeq! && markerSeq! < rejectSeq! && rejectSeq! < closeSeq!)) return null
  if (hasToolEventInStep(input, stepId, agendaSeq!, closeSeq!)) return null
  if (started.causationId !== agendaEvent.id || completed.causationId !== started.id || usageEvent.causationId !== completed.id
    || rejected.causationId !== marker.id || closed.causationId !== rejected.id) return null
  return { taskId: input.scope.rootTaskId, graphRevision: markerInfo.graphRevision, verificationDigest: markerInfo.verificationDigest,
    inputThroughSequence: stepSequence, consumedInputIds: [...fence.consumedInputIds], firstSequence: agendaSeq!, closeSequence: closeSeq! }
}

function ambiguousStepRows(steps: readonly Row[]): boolean {
  const ids = new Set<string>(), attempts = new Set<string>()
  for (const step of steps) {
    if (typeof step.id === "string") {
      if (ids.has(step.id)) return true
      ids.add(step.id)
    }
    if (!Number.isSafeInteger(step.ordinal) || Number(step.ordinal) < 0
      || !Number.isSafeInteger(step.attempt) || Number(step.attempt) < 1) continue
    const key = `${Number(step.ordinal)}:${Number(step.attempt)}`
    if (attempts.has(key)) return true
    attempts.add(key)
  }
  return false
}


/** Restores only the trailing strictly closed ordinary TaskGraph denial streak. */
export function restoreTaskGraphDenialProgress(input: ResumeInput): TaskGraphDenialProgress | undefined {
  if (ambiguousStepRows(input.steps)) return undefined
  let progress: TaskGraphDenialProgress | undefined
  let previousCloseSequence: bigint | undefined
  const orderedSteps = [...input.steps].sort((left, right) => Number(left.ordinal) - Number(right.ordinal) || Number(left.attempt) - Number(right.attempt))
  for (const step of orderedSteps) {
    const stepId = typeof step.id === "string" ? step.id : ""
    if (!stepId) { progress = undefined; previousCloseSequence = undefined; continue }
    const hasMarker = input.events.some(event => event.type === CHECKPOINT_EVENT && event.correlationId === stepId)
    if (!hasMarker) { progress = undefined; previousCloseSequence = undefined; continue }
    const denial = qualifyingStep(input, step)
    if (!denial) { progress = undefined; previousCloseSequence = undefined; continue }
    if (previousCloseSequence !== undefined && denial.firstSequence <= previousCloseSequence) progress = undefined
    progress = taskGraphDenialProgressFor({ schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, taskId: denial.taskId,
      graphRevision: denial.graphRevision, verificationDigest: denial.verificationDigest }, {
      taskGraphRevision: denial.graphRevision, inputThroughSequence: denial.inputThroughSequence, consumedInputIds: denial.consumedInputIds,
    }, progress)
    previousCloseSequence = denial.closeSequence
  }
  return progress
}
