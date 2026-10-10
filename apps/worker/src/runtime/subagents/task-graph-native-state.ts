import { TASK_GRAPH_LIMITS, type TaskGraphNode, type TaskGraphState } from "../planning/task-graph.js"
import type { TaskGraphNativeCommandReceipt, TaskGraphNativeNodeView, TaskGraphNativeSourceProvenance } from "./task-graph-native-command.js"

export const TASK_GRAPH_NATIVE_METADATA_VERSION = "agent-harness.v2.task-graph.native-delegation.v1" as const
export const TASK_GRAPH_NATIVE_TEMPLATE_ID = "native" as const
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
const HASH = /^[a-f0-9]{64}$/

/** Non-secret replay metadata; full execution context remains on the child task row. */
export type TaskGraphNativeDelegationMetadata = Readonly<{
  schemaVersion: typeof TASK_GRAPH_NATIVE_METADATA_VERSION
  operationKind: "spawn" | "followup"
  operationId: string
  requestFingerprint: string
  callerTaskId: string
  role: string
  taskType: string
  contextDigest: string
  contextBytes: number
  source?: TaskGraphNativeSourceProvenance
}>

export class TaskGraphNativeStateError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = "TaskGraphNativeStateError"
  }
}

export function parseTaskGraphNativeSource(value: unknown): TaskGraphNativeSourceProvenance | undefined {
  const row = record(value)
  if (!row || !exact(row, "attemptCount,graphNodeKey,origin,parentTaskId,resultDigest,role,rootTaskId,status,taskId,taskType,turnId")
    || !sourceId(row.taskId) || !sourceId(row.rootTaskId) || !(row.parentTaskId === null || sourceId(row.parentTaskId)) || !sourceId(row.turnId)
    || !label(row.role, 64) || !label(row.taskType, 128) || !TERMINAL.has(String(row.status))
    || !Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 0 || !HASH.test(String(row.resultDigest))
    || !(row.graphNodeKey === null || id(row.graphNodeKey))
    || row.origin !== "task_graph" && row.origin !== "native_legacy"
    || row.origin === "task_graph" && row.graphNodeKey === null
    || row.origin === "native_legacy" && row.graphNodeKey !== null) return undefined
  return {
    taskId: row.taskId as string, rootTaskId: row.rootTaskId as string, parentTaskId: row.parentTaskId as string | null,
    turnId: row.turnId as string, role: row.role as string, taskType: row.taskType as string,
    status: row.status as TaskGraphNativeSourceProvenance["status"], attemptCount: Number(row.attemptCount),
    resultDigest: row.resultDigest as string, graphNodeKey: row.graphNodeKey as string | null,
    origin: row.origin as TaskGraphNativeSourceProvenance["origin"],
  }
}

export function parseTaskGraphNativeDelegation(value: unknown): TaskGraphNativeDelegationMetadata | undefined {
  const row = record(value)
  if (!row) return undefined
  const hasSource = Object.hasOwn(row, "source")
  const keys = hasSource
    ? "callerTaskId,contextBytes,contextDigest,operationId,operationKind,requestFingerprint,role,schemaVersion,source,taskType"
    : "callerTaskId,contextBytes,contextDigest,operationId,operationKind,requestFingerprint,role,schemaVersion,taskType"
  if (!exact(row, keys) || row.schemaVersion !== TASK_GRAPH_NATIVE_METADATA_VERSION
    || row.operationKind !== "spawn" && row.operationKind !== "followup"
    || !id(row.operationId) || !HASH.test(String(row.requestFingerprint)) || !sourceId(row.callerTaskId)
    || !label(row.role, 64) || !label(row.taskType, 128) || !HASH.test(String(row.contextDigest))
    || !Number.isSafeInteger(row.contextBytes) || Number(row.contextBytes) < 0 || Number(row.contextBytes) > TASK_GRAPH_LIMITS.maxSnapshotBytes) return undefined
  const source = hasSource ? parseTaskGraphNativeSource(row.source) : undefined
  if (hasSource && (!source || row.operationKind !== "followup" || source.role !== row.role || source.taskType !== row.taskType)
    || row.operationKind === "followup" && !source) return undefined
  return {
    schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: row.operationKind,
    operationId: row.operationId as string, requestFingerprint: row.requestFingerprint as string,
    callerTaskId: row.callerTaskId as string, role: row.role as string, taskType: row.taskType as string,
    contextDigest: row.contextDigest as string, contextBytes: Number(row.contextBytes),
    ...(source ? { source } : {}),
  }
}

export function parseTaskGraphNativeReceipt(value: unknown): TaskGraphNativeCommandReceipt | undefined {
  const row = record(value), child = row && record(row.child)
  const hasSource = row !== null && Object.hasOwn(row, "source")
  const receiptKeys = hasSource
    ? "child,dispatchDisposition,graphRevision,nodeKey,operationId,replay,requestFingerprint,source,status"
    : "child,dispatchDisposition,graphRevision,nodeKey,operationId,replay,requestFingerprint,status"
  if (!row || !child || !exact(row, receiptKeys)
    || !exact(child, "depth,parentTaskId,path,role,rootTaskId,status,taskId,taskType")
    || row.status !== "accepted" && row.status !== "duplicate" || row.replay !== (row.status === "duplicate")
    || !id(row.operationId) || !HASH.test(String(row.requestFingerprint)) || !Number.isSafeInteger(row.graphRevision) || Number(row.graphRevision) < 1
    || !id(row.nodeKey) || !id(child.taskId) || !id(child.rootTaskId) || !id(child.parentTaskId)
    || typeof child.path !== "string" || !child.path.startsWith("/") || child.path.length > 2_048
    || !Number.isSafeInteger(child.depth) || Number(child.depth) < 0 || Number(child.depth) > TASK_GRAPH_LIMITS.maxDepth
    || !label(child.role, 64) || !label(child.taskType, 128) || child.status !== "queued" && child.status !== "waiting"
    || row.dispatchDisposition !== (child.status === "queued" ? "pending" : "not_ready")) return undefined
  const source = Object.hasOwn(row, "source") ? parseTaskGraphNativeSource(row.source) : undefined
  if (Object.hasOwn(row, "source") && !source || source && (source.role !== child.role || source.taskType !== child.taskType)) return undefined
  return {
    status: row.status, replay: row.replay, operationId: row.operationId as string,
    requestFingerprint: row.requestFingerprint as string, graphRevision: Number(row.graphRevision), nodeKey: row.nodeKey as string,
    dispatchDisposition: row.dispatchDisposition as TaskGraphNativeCommandReceipt["dispatchDisposition"],
    child: {
      taskId: child.taskId as string, rootTaskId: child.rootTaskId as string, parentTaskId: child.parentTaskId as string,
      path: child.path, depth: Number(child.depth), role: child.role as string, taskType: child.taskType as string,
      status: child.status as TaskGraphNativeCommandReceipt["child"]["status"],
    },
    ...(source ? { source } : {}),
  }
}

export function appendTaskGraphNativeNode(input: Readonly<{
  state: TaskGraphState
  maxDepth: number
  key: string
  goal: string
  successCriteria: readonly string[]
  dependsOn: readonly string[]
  metadata: TaskGraphNativeDelegationMetadata
  verifiedSource?: boolean
}>): Readonly<{ state: TaskGraphState; node: TaskGraphNode }> {
  const { state, maxDepth, key, goal, successCriteria, dependsOn, metadata, verifiedSource = false } = input
  if (!parseTaskGraphNativeDelegation(metadata)) throw new TaskGraphNativeStateError("native_graph_metadata_invalid")
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= 2_147_483_646
    || !Array.isArray(state.nodes) || state.nodes.length >= TASK_GRAPH_LIMITS.maxNodes
    || state.nodes.some(node => node.key === key) || !id(key) || !label(goal, 4_000)
    || !stringList(successCriteria, 32, 1_000) || !Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length) {
    throw new TaskGraphNativeStateError("native_graph_node_invalid")
  }
  const dependencies = new Map(state.nodes.map(node => [node.key, node] as const))
  const parents = dependsOn.map(dependency => dependencies.get(dependency))
  const sourceNode = metadata.source?.origin === "task_graph" && metadata.source.graphNodeKey
    ? dependencies.get(metadata.source.graphNodeKey) : undefined
  if (metadata.source?.origin === "task_graph" && (!sourceNode || sourceNode.taskId !== metadata.source.taskId
    || sourceNode.status !== metadata.source.status)) throw new TaskGraphNativeStateError("native_graph_source_invalid")
  const sourceDependency = verifiedSource && metadata.source?.origin === "task_graph" && metadata.source.status === "completed"
    && sourceNode?.verificationDisposition === "typed"
    ? metadata.source.graphNodeKey : null
  if (parents.some(node => !node) || (sourceDependency ? dependsOn.length !== 1 || dependsOn[0] !== sourceDependency : dependsOn.length !== 0)) {
    throw new TaskGraphNativeStateError("native_graph_dependency_invalid")
  }
  const depth = parents.reduce((maximum, node) => Math.max(maximum, node?.depth ?? 0), 0) + 1
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || depth > Math.min(maxDepth, TASK_GRAPH_LIMITS.maxDepth)) {
    throw new TaskGraphNativeStateError("native_graph_depth_limit")
  }
  const node: TaskGraphNode = {
    key, templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID, goal, successCriteria: [...successCriteria], dependsOn: [...dependsOn],
    depth, status: "queued", verificationDisposition: "legacy_unverified", nativeDelegation: metadata,
  }
  return { state: { ...state, revision: state.revision + 1, nodes: [...state.nodes, node] }, node }
}

export function taskGraphNativeNodeView(metadata: TaskGraphNativeDelegationMetadata): TaskGraphNativeNodeView {
  return {
    operationKind: metadata.operationKind, operationId: metadata.operationId,
    requestFingerprint: metadata.requestFingerprint, callerTaskId: metadata.callerTaskId,
    role: metadata.role, taskType: metadata.taskType, contextDigest: metadata.contextDigest,
    ...(metadata.source ? { source: metadata.source } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null } catch { return null }
}
function exact(value: Record<string, unknown>, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128 }
function sourceId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function label(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max }
function stringList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index) || !label(value[index], maxLength)) return false
  return true
}
