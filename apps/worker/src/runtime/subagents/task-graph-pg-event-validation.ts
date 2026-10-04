import { createHash } from "node:crypto"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { TaskGraphEvent } from "../planning/task-graph.js"
import {
  canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId,
  TASK_GRAPH_ITEM_TYPE, type TaskGraphSnapshot,
} from "./task-graph-snapshot.js"

type ReceiptScope = Readonly<{ sessionId: string; turnId: string; parentTaskId: string }>
type LoadedItem = Readonly<{ id: string; revision: number }>
type Row = Record<string, unknown>
type VerificationScope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string; taskId: string; attemptCount: number }>
export type TaskGraphReplaySource = Readonly<{ toolCallId: string; resultItemId: string }>
export type TaskGraphReplayProof = Readonly<{ currentCallId: string; source: TaskGraphReplaySource }>
export type TaskGraphReplayReceipt = Readonly<{ currentCallId: string; sourceCallItem: readonly [string, number]; sourceResultItem: readonly [string, number] }>
export type TaskGraphEventValidation = Readonly<{ outcomes: Map<string, "completed" | "failed">; replays: readonly TaskGraphReplayProof[] }>
export const TASK_GRAPH_REPLAY_CALL_PREFIX = "task-graph-replay-v1:" as const

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function graph(value: unknown): TaskGraphSnapshot {
  try { return parseTaskGraphSnapshot(value) } catch { throw new Error("task_graph_receipt_invalid") }
}

function receiptItem(value: unknown, receiptRevision: number, payloadContent: unknown, loaded: LoadedItem,
  current: TaskGraphSnapshot, scope: ReceiptScope): TaskGraphSnapshot {
  const item = object(value)
  if (!item || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== loaded.id
    || item.id !== taskGraphItemId(scope.parentTaskId) || item.sessionId !== scope.sessionId
    || item.turnId !== scope.turnId || item.taskId !== scope.parentTaskId || item.type !== TASK_GRAPH_ITEM_TYPE
    || item.revision !== receiptRevision || receiptRevision > loaded.revision) throw new Error("task_graph_receipt_invalid")
  const content = graph(item.content)
  if (payloadContent !== undefined && canonicalTaskGraphJson(graph(payloadContent)) !== canonicalTaskGraphJson(content)) {
    throw new Error("task_graph_receipt_invalid")
  }
  if (receiptRevision === loaded.revision && canonicalTaskGraphJson(content) !== canonicalTaskGraphJson(current)) {
    throw new Error("task_graph_receipt_invalid")
  }
  return content
}

function validateProposal(payload: Row, loaded: LoadedItem, current: TaskGraphSnapshot, scope: ReceiptScope): void {
  const receipt = object(payload.receipt)
  if (!text(payload.fingerprint) || !revision(payload.revision) || payload.revision > loaded.revision
    || !receipt || receipt.revision !== payload.revision
    || (receipt.status !== "accepted" && receipt.status !== "duplicate")
    || !Array.isArray(receipt.nodes) || receipt.nodes.length === 0 || !Array.isArray(receipt.readyTaskIds)
    || !("content" in payload)) {
    throw new Error("task_graph_receipt_invalid")
  }
  const content = receiptItem(payload.item, payload.revision, payload.content, loaded, current, scope)
  const nodes = new Map(content.nodes.map(node => [node.key, node.taskId] as const))
  const receipts = new Map<string, "queued" | "waiting">()
  const taskIds = new Set<string>()
  for (const value of receipt.nodes) {
    const node = object(value)
    if (!node || !text(node.key) || !text(node.taskId) || (node.status !== "queued" && node.status !== "waiting")
      || nodes.get(node.key) !== node.taskId || receipts.has(node.key) || taskIds.has(node.taskId)) {
      throw new Error("task_graph_receipt_invalid")
    }
    receipts.set(node.key, node.status)
    taskIds.add(node.taskId)
  }
  const ready = new Set<string>()
  for (const id of receipt.readyTaskIds) {
    if (!text(id) || ready.has(id) || !taskIds.has(id)) throw new Error("task_graph_receipt_invalid")
    ready.add(id)
  }
  if ([...ready].some(id => ![...receipts].some(([key, status]) => status === "queued" && nodes.get(key) === id))) {
    throw new Error("task_graph_receipt_invalid")
  }
}

/** Rejects unknown persisted envelopes before lifecycle state can be reconstructed. */
export function parsePersistedTaskGraphReceipt(eventType: unknown, value: unknown, loaded: LoadedItem,
  current: TaskGraphSnapshot, scope: ReceiptScope): TaskGraphEvent | null {
  const payload = object(value)
  if (!payload) throw new Error("task_graph_event_envelope_invalid")
  if (eventType === "item.delta" && payload.kind === "proposal") {
    validateProposal(payload, loaded, current, scope)
    return null
  }
  if ((eventType !== "item.delta" && eventType !== "task_graph.lifecycle") || payload.kind !== "lifecycle") {
    throw new Error("task_graph_event_envelope_invalid")
  }
  const event = parseTaskGraphEvent(payload.event)
  if (!event) throw new Error("task_graph_lifecycle_event_invalid")
  if (!revision(payload.revision) || payload.revision > loaded.revision || event.expectedRevision !== payload.revision - 1) {
    throw new Error("task_graph_lifecycle_receipt_invalid")
  }
  const content = receiptItem(payload.item, payload.revision, undefined, loaded, current, scope)
  if (!content.nodes.some(node => node.key === event.nodeKey)) throw new Error("task_graph_lifecycle_receipt_invalid")
  return event
}

/** Validate current-attempt lifecycle receipts and bind replay markers to both lifecycle events. */
export function validateTaskGraphToolEvents(values: readonly unknown[], items: readonly Row[], scope: VerificationScope): TaskGraphEventValidation {
  const calls = new Map(items.filter(item => item.type === "tool_call").map(item => [String((item.content as Row).toolCallId), item] as const)), byItem = new Map([...calls.values()].map(item => [String(item.id), String((item.content as Row).toolCallId)] as const))
  const grouped = new Map<string, Row[]>()
  for (const value of values) {
    const event = object(value), payload = object(event?.payload)
    const byCorrelation = event && calls.has(String(event.correlationId)) ? String(event.correlationId) : undefined, callId = event ? byItem.get(String(event.itemId)) ?? byCorrelation ?? String(payload?.toolCallId) : undefined
    const call = callId ? calls.get(callId) : undefined
    if (!event || !payload || !call || event.taskId !== scope.taskId || event.itemId !== call.id || event.correlationId !== (call.content as Row).toolCallId
      || !["tool_call.started", "tool_call.completed", "tool_call.failed"].includes(String(event.type)) || payload.taskId !== scope.taskId || payload.toolCallId !== (call.content as Row).toolCallId
      || payload.toolName !== (call.content as Row).toolName || !Number.isSafeInteger(Number(event.sequence))) throw new Error("task_graph_verification_event_invalid")
    const list = grouped.get(callId!) ?? []; list.push(event); grouped.set(callId!, list)
  }
  const outcomes = new Map<string, "completed" | "failed">(), replays: TaskGraphReplayProof[] = []
  for (const [callId, call] of calls) {
    const list = grouped.get(callId) ?? [], started = list.filter(event => event.type === "tool_call.started"), terminal = list.filter(event => event.type !== "tool_call.started")
    const payload = object(terminal[0]?.payload), content = call.content as Row, outcome = content.status
    if (started.length !== 1 || terminal.length !== 1 || !payload || Number(started[0]?.sequence) >= Number(terminal[0]?.sequence) || payload.toolVersion !== undefined && payload.toolVersion !== content.toolVersion
      || payload.errorCode !== content.errorCode
      || (outcome === "completed" ? terminal[0]?.type !== "tool_call.completed" || payload.status !== "completed" || payload.errorCode !== null
        : terminal[0]?.type !== "tool_call.failed" || payload.status !== "failed" || !text(payload.errorCode))) throw new Error("task_graph_verification_event_ambiguous")
    const startPayload = object(started[0]?.payload), isReplay = callId.startsWith(TASK_GRAPH_REPLAY_CALL_PREFIX)
    const hasStartSource = !!startPayload && Object.hasOwn(startPayload, "replaySource"), hasTerminalSource = Object.hasOwn(payload, "replaySource")
    if (isReplay !== hasStartSource || isReplay !== hasTerminalSource) throw new Error("task_graph_verification_replay_source_missing")
    if (isReplay) {
      const source = replaySource(payload.replaySource), startSource = replaySource(startPayload?.replaySource)
      if (!source || !startSource || canonicalTaskGraphJson(source) !== canonicalTaskGraphJson(startSource)
        || replayCallId(String(call.stepId), source.toolCallId) !== callId) throw new Error("task_graph_verification_replay_source_invalid")
      replays.push({ currentCallId: callId, source })
    }
    outcomes.set(callId, outcome as "completed" | "failed")
  }
  const sourceIds = new Set<string>(), sourceCallIds = new Set<string>()
  for (const replay of replays) {
    if (sourceIds.has(replay.source.resultItemId) || sourceCallIds.has(replay.source.toolCallId)) throw new Error("task_graph_verification_replay_source_duplicate")
    sourceIds.add(replay.source.resultItemId); sourceCallIds.add(replay.source.toolCallId)
  }
  return { outcomes, replays }
}

/** Verify each explicit historical source row and lifecycle; no unlinked history is accepted. */
export function validateTaskGraphReplaySources(proofs: readonly TaskGraphReplayProof[], rows: readonly unknown[], events: readonly unknown[], items: readonly Row[], scope: VerificationScope): readonly TaskGraphReplayReceipt[] {
  if (proofs.length === 0) { if (rows.length || events.length) throw new Error("task_graph_verification_replay_source_invalid"); return [] }
  const sources = rows.map(object)
  if (sources.some(row => !row) || sources.length !== proofs.length) throw new Error("task_graph_verification_replay_source_missing")
  const currentCalls = new Map(items.filter(item => item.type === "tool_call").map(item => [String((item.content as Row).toolCallId), item] as const)), eventGroups = new Map<string, Row[]>()
  for (const value of events) {
    const event = object(value), payload = object(event?.payload)
    if (!event || !payload || event.userId !== scope.userId || event.sessionId !== scope.sessionId || event.turnId !== scope.turnId || event.taskId !== scope.taskId
      || !text(event.itemId) || !text(event.correlationId) || payload.taskId !== scope.taskId) throw new Error("task_graph_verification_replay_event_invalid")
    const group = eventGroups.get(event.itemId) ?? []; group.push(event); eventGroups.set(event.itemId, group)
  }
  const receipts: TaskGraphReplayReceipt[] = [], usedCallItems = new Set<string>(), usedResultItems = new Set<string>()
  for (const proof of proofs) {
    const current = currentCalls.get(proof.currentCallId), currentContent = object(current?.content), currentResult = items.find(item => item.type === "tool_result" && object(item.content)?.toolCallId === proof.currentCallId), currentResultContent = object(currentResult?.content)
    const matches = sources.filter((row): row is Row => !!row && row.sourceResultItemId === proof.source.resultItemId)
    if (!current || !currentContent || !currentResult || !currentResultContent || matches.length !== 1) throw new Error("task_graph_verification_replay_source_missing")
    const source = matches[0]!, callContent = object(source.sourceCallContent), resultContent = object(source.sourceResultContent)
    if (!callContent || !resultContent || !strictText(source.sourceCallItemId) || !strictText(source.sourceResultItemId)
      || source.sourceSessionId !== scope.sessionId || source.sourceTurnId !== scope.turnId || source.sourceTaskId !== scope.taskId
      || source.sourceRootTaskId !== scope.rootTaskId || source.sourceTurnRootTaskId !== scope.rootTaskId || source.sourceParentTaskId !== scope.parentTaskId || source.sourceUserId !== scope.userId
      || source.sourceResultItemId !== proof.source.resultItemId || source.sourceCallStepId !== source.sourceResultStepId
      || Number(source.sourceCallAttempt) !== Number(source.sourceResultAttempt) || Number(source.sourceResultAttempt) >= scope.attemptCount
      || Number(source.sourceResultAttempt) < 1 || Number(source.sourceCallOrdinal) !== Number(source.sourceResultOrdinal)
      || source.sourceCallType !== "tool_call" || source.sourceResultType !== "tool_result"
      || source.sourceCallStatus !== "completed" || source.sourceResultStatus !== "completed"
      || !Number.isSafeInteger(Number(source.sourceCallRevision)) || Number(source.sourceCallRevision) < 0 || !Number.isSafeInteger(Number(source.sourceResultRevision)) || Number(source.sourceResultRevision) < 0
      || callContent.toolCallId !== proof.source.toolCallId || resultContent.toolCallId !== proof.source.toolCallId || proof.source.toolCallId.startsWith(TASK_GRAPH_REPLAY_CALL_PREFIX)
      || callContent.status !== "completed" || callContent.errorCode !== null || resultContent.errorCode !== null || !Object.hasOwn(callContent, "input")
      || !Object.hasOwn(resultContent, "output") || truncated(resultContent.output) || truncated(currentResultContent.output)
      || canonicalTaskGraphJson(callContent.toolName) !== canonicalTaskGraphJson(currentContent.toolName)
      || canonicalTaskGraphJson(callContent.toolVersion) !== canonicalTaskGraphJson(currentContent.toolVersion)
      || canonicalTaskGraphJson(callContent.input) !== canonicalTaskGraphJson(currentContent.input)
      || canonicalTaskGraphJson(resultContent.output) !== canonicalTaskGraphJson(currentResultContent.output)
      || currentContent.status !== "completed" || currentContent.errorCode !== null || currentResultContent.errorCode !== null) throw new Error("task_graph_verification_replay_source_mismatch")
    const group = eventGroups.get(String(source.sourceCallItemId)) ?? [], started = group.filter(event => event.type === "tool_call.started"), completed = group.filter(event => event.type === "tool_call.completed")
    const startPayload = object(started[0]?.payload), terminalPayload = object(completed[0]?.payload)
    if (group.length !== 2 || started.length !== 1 || completed.length !== 1
      || !Number.isSafeInteger(Number(started[0]?.sequence)) || !Number.isSafeInteger(Number(completed[0]?.sequence))
      || Number(started[0]?.sequence) >= Number(completed[0]?.sequence)
      || [started[0], completed[0]].some(event => event?.itemId !== source.sourceCallItemId || event.taskId !== scope.taskId || event.correlationId !== proof.source.toolCallId)
      || [startPayload, terminalPayload].some(payload => !payload || payload.taskId !== scope.taskId || payload.toolCallId !== proof.source.toolCallId || payload.toolName !== callContent.toolName || Object.hasOwn(payload, "replaySource"))
      || [startPayload, terminalPayload].some(payload => payload?.toolVersion !== undefined && payload.toolVersion !== callContent.toolVersion)
      || terminalPayload?.status !== "completed" || terminalPayload.errorCode !== null) throw new Error("task_graph_verification_replay_lifecycle_invalid")
    if (usedCallItems.has(String(source.sourceCallItemId)) || usedResultItems.has(String(source.sourceResultItemId))) throw new Error("task_graph_verification_replay_source_duplicate")
    usedCallItems.add(String(source.sourceCallItemId)); usedResultItems.add(String(source.sourceResultItemId))
    receipts.push({ currentCallId: proof.currentCallId, sourceCallItem: [String(source.sourceCallItemId), Number(source.sourceCallRevision)], sourceResultItem: [String(source.sourceResultItemId), Number(source.sourceResultRevision)] })
  }
  if (events.length !== proofs.length * 2) throw new Error("task_graph_verification_replay_lifecycle_invalid")
  return receipts
}

function replaySource(value: unknown): TaskGraphReplaySource | undefined {
  const source = object(value)
  return source && Reflect.ownKeys(source).length === 2 && strictText(source.toolCallId) && strictText(source.resultItemId)
    ? { toolCallId: source.toolCallId, resultItemId: source.resultItemId } : undefined
}
function replayCallId(stepId: string, sourceCallId: string): string {
  return `${TASK_GRAPH_REPLAY_CALL_PREFIX}${createHash("sha256").update(JSON.stringify([stepId, sourceCallId])).digest("hex")}`
}
function strictText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function truncated(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 32 || value === "[TRUNCATED]" || typeof value === "string" && value.includes("...[TRUNCATED]")) return true
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return true
  seen.add(value)
  try { if (!Array.isArray(value) && (value as Row).truncated === true && typeof (value as Row).preview === "string" && Number.isSafeInteger((value as Row).byteLength)) return true
    return (Array.isArray(value) ? value : Object.values(value)).some(child => truncated(child, seen, depth + 1))
  } finally { seen.delete(value) }
}
