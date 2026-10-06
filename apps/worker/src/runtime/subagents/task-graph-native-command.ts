import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import type { SubagentTaskStatus } from "./types.js"
import type { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseTaskGraphNativeReceipt } from "./task-graph-native-state.js"

type Row = Record<string, unknown>
const HASH = /^[a-f0-9]{64}$/

/** Normalized public native coordination inputs. The key is command-scoped, not revision-scoped. */
export type TaskGraphNativeSpawnRequest = Readonly<{
  kind: "spawn"
  idempotencyKey: string
  role: string
  taskType: string
  goal: string
  constraints?: readonly string[]
  successCriteria?: readonly string[]
  allowedActions?: readonly string[]
  context?: unknown
  parentTaskId?: string
}>
export type TaskGraphNativeFollowupRequest = Readonly<{
  kind: "followup"
  idempotencyKey: string
  sourceTaskId: string
  goal: string
  constraints?: readonly string[]
  successCriteria?: readonly string[]
  context?: unknown
}>
export type TaskGraphNativeRequest = TaskGraphNativeSpawnRequest | TaskGraphNativeFollowupRequest
export type TaskGraphNativeCommandInput = Readonly<{
  scope: TaskGraphExecutionScope
  request: TaskGraphNativeRequest
  /** Runtime-owned structured-result contract, never accepted from model input. */
  outputSchemaMarker?: Readonly<{ schemaVersion: typeof ROLE_RESULT_SCHEMA; role: "scout" | "analyst" }>
}>

/** Server-read follow-up provenance, frozen in the operation receipt and child context. */
export type TaskGraphNativeSourceProvenance = Readonly<{
  taskId: string
  rootTaskId: string
  parentTaskId: string | null
  turnId: string
  role: string
  taskType: string
  status: Extract<SubagentTaskStatus, "completed" | "failed" | "interrupted" | "cancelled" | "closed">
  attemptCount: number
  resultDigest: string
  graphNodeKey: string | null
  origin: "task_graph" | "native_legacy"
}>

/** The child task's stored state is distinct from whether it is ready for dispatch. */
export type TaskGraphNativeChildReceipt = Readonly<{
  taskId: string
  rootTaskId: string
  parentTaskId: string
  path: string
  depth: number
  role: string
  taskType: string
  status: Extract<SubagentTaskStatus, "queued" | "waiting">
}>

export type TaskGraphNativeCommandReceipt = Readonly<{
  status: "accepted" | "duplicate"
  replay: boolean
  operationId: string
  requestFingerprint: string
  graphRevision: number
  nodeKey: string
  /** Outbox intent only; broker publication is a later operation. */
  dispatchDisposition: "pending" | "not_ready"
  child: TaskGraphNativeChildReceipt
  source?: TaskGraphNativeSourceProvenance
}>

/** Safe read-model view; execution context and full caller constraints stay on the scoped child task. */
export type TaskGraphNativeNodeView = Readonly<{
  operationKind: "spawn" | "followup"
  operationId: string
  requestFingerprint: string
  callerTaskId: string
  role: string
  taskType: string
  contextDigest: string
  source?: TaskGraphNativeSourceProvenance
}>

/** Structural provenance only; never an assertion of semantic success or artifact approval. */
export type TaskGraphNativeResultReceipt = Readonly<{
  schemaVersion: "agent-harness.v2.task-graph.native-result.v1"
  role: string
  taskStatus: SubagentTaskStatus
  disposition: "structured" | "opaque" | "missing"
  resultDigest: string | null
}>

/** Validates a durable native event against its exact event, item and snapshot identity. */
export function parsePersistedTaskGraphNativeReceipt(value: unknown, event: Readonly<{
  type: unknown; itemId: unknown; taskId: unknown; idempotencyKey: unknown;
}>, loaded: Readonly<{ id: string; revision: number }>, current: TaskGraphSnapshot,
scope: Readonly<{ sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string }>): TaskGraphNativeCommandReceipt {
  const payload = record(value)
  if (!payload || !exact(payload, "content,item,kind,receipt,requestFingerprint,revision") || payload.kind !== "native_command"
    || !HASH.test(String(payload.requestFingerprint)) || !Number.isSafeInteger(payload.revision) || Number(payload.revision) < 1) invalidReceipt()
  const receipt = parseTaskGraphNativeReceipt(payload.receipt)
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(payload.content) } catch { return invalidReceipt() }
  const item = record(payload.item), revision = Number(payload.revision), itemId = taskGraphItemId(scope.parentTaskId)
  if (!receipt || receipt.status !== "accepted" || receipt.replay || receipt.requestFingerprint !== payload.requestFingerprint
    || receipt.graphRevision !== revision || revision > loaded.revision || loaded.id !== itemId
    || !item || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== itemId || item.sessionId !== scope.sessionId
    || item.turnId !== scope.turnId || item.taskId !== scope.parentTaskId || item.type !== "task_graph" || item.revision !== revision
    || event.type !== (revision === 1 ? "item.started" : "item.delta") || event.itemId !== itemId
    || event.taskId !== scope.parentTaskId || typeof event.idempotencyKey !== "string"
    || !new RegExp(`^${escapeRegex(itemId)}:native:[a-f0-9]{64}$`).test(event.idempotencyKey)
    || canonicalTaskGraphJson(item.content) !== canonicalTaskGraphJson(snapshot)
    || revision === loaded.revision && canonicalTaskGraphJson(snapshot) !== canonicalTaskGraphJson(current)) invalidReceipt()
  const node = snapshot.nodes.find(candidate => candidate.key === receipt.nodeKey), latest = current.nodes.find(candidate => candidate.key === receipt.nodeKey)
  const metadata = node?.nativeDelegation, latestMetadata = latest?.nativeDelegation
  if (!node || !latest || node.taskId !== receipt.child.taskId || latest.taskId !== node.taskId
    || receipt.child.rootTaskId !== scope.rootTaskId || receipt.child.parentTaskId !== scope.parentTaskId
    || !metadata || !latestMetadata || canonicalTaskGraphJson(metadata) !== canonicalTaskGraphJson(latestMetadata)
    || metadata.operationId !== receipt.operationId || metadata.requestFingerprint !== receipt.requestFingerprint
    || metadata.callerTaskId !== scope.parentTaskId || metadata.operationKind !== (metadata.source ? "followup" : "spawn")
    || metadata.role !== receipt.child.role || metadata.taskType !== receipt.child.taskType
    || canonicalTaskGraphJson(metadata.source ?? null) !== canonicalTaskGraphJson(receipt.source ?? null)
    || (metadata.operationKind === "followup") !== Object.hasOwn(receipt, "source")
    || metadata.source && (metadata.source.taskId === scope.rootTaskId || metadata.source.rootTaskId !== scope.rootTaskId
      || metadata.source.turnId !== scope.turnId
      || metadata.source.origin === "task_graph" && current.nodes.find(source => source.key === metadata.source?.graphNodeKey)?.taskId !== metadata.source.taskId)
    || node.dependsOn.some(key => key !== metadata.source?.graphNodeKey)
    || node.dependsOn.length > 0 && (metadata.source?.origin !== "task_graph" || metadata.source.status !== "completed"
      || current.nodes.find(source => source.key === metadata.source?.graphNodeKey)?.verificationDisposition !== "typed")) invalidReceipt()
  return receipt
}

function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { return Object.getPrototypeOf(parsed) === Object.prototype ? parsed as Row : null } catch { return null }
}
function exact(value: Row, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }
function invalidReceipt(): never { throw new Error("task_graph_native_receipt_invalid") }
