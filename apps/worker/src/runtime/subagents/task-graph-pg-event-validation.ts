import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { TaskGraphEvent } from "../planning/task-graph.js"
import {
  canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId,
  TASK_GRAPH_ITEM_TYPE, type TaskGraphSnapshot,
} from "./task-graph-snapshot.js"

type ReceiptScope = Readonly<{ sessionId: string; turnId: string; parentTaskId: string }>
type LoadedItem = Readonly<{ id: string; revision: number }>
type Row = Record<string, unknown>

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
