import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type {
  TaskGraphCommandPort,
  TaskGraphExecutionScope,
  TaskGraphNativeCommandInput,
  TaskGraphNativeCommandReceipt,
  TaskGraphNativeChildReceipt,
  TaskGraphNativeSourceProvenance,
  TaskGraphNativeRequest,
} from "../subagents/task-graph-command-port.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { CoordinationError, type NativeCoordinationRuntimeOptions } from "./coordination-types.js"
import type { ToolExecutionContext } from "./types.js"

export const NATIVE_COORDINATION_RECEIPT_SCHEMA = "agent-harness.v2.native-coordination-receipt.v1" as const
const SHA256 = /^[a-f0-9]{64}$/
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const NATIVE_COORDINATION_TOOLS = new Set(["agent.spawn", "spawn_subagent", "agent.followup"])

export type NativeCoordinationReceipt = Readonly<{
  schemaVersion: typeof NATIVE_COORDINATION_RECEIPT_SCHEMA
  operationKind: "spawn" | "followup"
  status: "accepted" | "duplicate"
  replay: boolean
  operationId: string
  requestFingerprint: string
  graphRevision: number
  nodeKey: string
  dispatchDisposition: "pending" | "not_ready"
  rootTaskId: string
  child: TaskGraphNativeCommandReceipt["child"]
}>

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== "string")) return null
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) return null
  }
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected
}
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
}
function parsedSource(value: unknown, child: TaskGraphNativeChildReceipt, turnId?: string): TaskGraphNativeSourceProvenance | undefined {
  const source = record(value)
  if (!source || !exactKeys(source, "attemptCount,graphNodeKey,origin,parentTaskId,resultDigest,role,rootTaskId,status,taskId,taskType,turnId")
    || !boundedText(source.taskId, 128)
    || !(source.parentTaskId === null || boundedText(source.parentTaskId, 128))
    || !boundedText(source.turnId, 128) || turnId !== undefined && source.turnId !== turnId
    || !boundedText(source.role, 64) || source.role !== child.role || !boundedText(source.taskType, 128) || source.taskType !== child.taskType
    || !["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(source.status))
    || !Number.isSafeInteger(source.attemptCount) || Number(source.attemptCount) < 0
    || typeof source.resultDigest !== "string" || !SHA256.test(source.resultDigest)
    || !boundedText(source.rootTaskId, 128) || source.rootTaskId !== child.rootTaskId || source.taskId === child.taskId
    || !(source.origin === "task_graph" && boundedText(source.graphNodeKey, 128)
      || source.origin === "native_legacy" && source.graphNodeKey === null)) return undefined
  return {
    taskId: source.taskId, rootTaskId: source.rootTaskId, parentTaskId: source.parentTaskId as string | null,
    turnId: source.turnId, role: source.role, taskType: source.taskType,
    status: source.status as TaskGraphNativeSourceProvenance["status"], attemptCount: source.attemptCount as number,
    resultDigest: source.resultDigest, graphNodeKey: source.graphNodeKey as string | null,
    origin: source.origin as TaskGraphNativeSourceProvenance["origin"],
  }
}
function nativeError(error: unknown): CoordinationError {
  let code: unknown
  try {
    const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined
    code = descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch { code = undefined }
  const safeCode = typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "native_admission_failed"
  return new CoordinationError(`coordination_${safeCode}`, "Native TaskGraph coordination was rejected")
}

export function plannerEnabledRoot(context: ToolExecutionContext, enabled: boolean): boolean {
  if (!enabled || context.actorRole === "subagent") return false
  if (context.taskId === context.rootTaskId && typeof context.taskId === "string" && context.taskId.trim()) return true
  return context.actorRole === "orchestrator" && (!context.taskId || !context.rootTaskId)
}

export function nativeCoordinationKey(context: ToolExecutionContext, operation: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!boundedText(explicit, 256)) throw new CoordinationError("coordination_invalid_input", "Invalid coordination idempotency key")
    return explicit
  }
  const callId = context.toolCallId
  if (!boundedText(callId, 256)) throw new CoordinationError("coordination_scope_error", "Stable tool invocation identity is unavailable")
  const stableIdentity = JSON.stringify(["agent-harness.v2.native-coordination", context.sessionId, context.turnId, callId, operation])
  return `native:${createHash("sha256").update(stableIdentity).digest("hex")}`
}

function executionScope(context: ToolExecutionContext, options: NativeCoordinationRuntimeOptions): TaskGraphExecutionScope {
  const attempt = options.parentAttemptCount()
  if (!context.scope.userId.trim() || !context.sessionId.trim() || !context.turnId.trim() || !context.stepId.trim()
    || typeof context.taskId !== "string" || !context.taskId.trim() || context.taskId !== context.rootTaskId
    || !options.turnLeaseOwner.trim() || !options.parentLeaseOwner.trim()
    || !Number.isSafeInteger(options.turnLeaseVersion) || options.turnLeaseVersion < 1
    || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new CoordinationError("coordination_task_graph_scope_unavailable", "The server could not establish the active root task fence")
  }
  return {
    userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, rootTaskId: context.taskId,
    parentTaskId: context.taskId, stepId: context.stepId, turnLeaseOwner: options.turnLeaseOwner,
    turnLeaseVersion: options.turnLeaseVersion, parentLeaseOwner: options.parentLeaseOwner, parentAttemptCount: attempt,
  }
}

function parseNativeCommandReceipt(value: unknown, kind?: TaskGraphNativeRequest["kind"], turnId?: string): TaskGraphNativeCommandReceipt | undefined {
  const row = record(value), child = record(row?.child)
  if (!row || !child || !(exactKeys(row, "child,dispatchDisposition,graphRevision,nodeKey,operationId,replay,requestFingerprint,status")
      || exactKeys(row, "child,dispatchDisposition,graphRevision,nodeKey,operationId,replay,requestFingerprint,source,status"))
    || !exactKeys(child, "depth,parentTaskId,path,role,rootTaskId,status,taskId,taskType")
    || (row.status !== "accepted" && row.status !== "duplicate") || typeof row.replay !== "boolean" || row.replay !== (row.status === "duplicate")
    || !boundedText(row.operationId, 256) || typeof row.requestFingerprint !== "string" || !SHA256.test(row.requestFingerprint)
    || !Number.isSafeInteger(row.graphRevision) || Number(row.graphRevision) < 1 || !boundedText(row.nodeKey, 128)
    || !boundedText(child.taskId, 128) || !boundedText(child.rootTaskId, 128) || !boundedText(child.parentTaskId, 128)
    || !boundedText(child.path, 2_048) || !Number.isSafeInteger(child.depth) || Number(child.depth) < 1 || Number(child.depth) > 8
    || !boundedText(child.role, 64) || !boundedText(child.taskType, 128)
    || (child.status !== "queued" && child.status !== "waiting")
    || row.dispatchDisposition !== (child.status === "queued" ? "pending" : "not_ready")) return undefined
  const safeChild: TaskGraphNativeChildReceipt = {
    taskId: child.taskId, rootTaskId: child.rootTaskId, parentTaskId: child.parentTaskId, path: child.path,
    depth: child.depth as number, role: child.role, taskType: child.taskType, status: child.status,
  }
  const source = Object.hasOwn(row, "source") ? parsedSource(row.source, safeChild, turnId) : undefined
  if (Object.hasOwn(row, "source") && !source || kind === "spawn" && source) return undefined
  return {
    status: row.status as TaskGraphNativeCommandReceipt["status"], replay: row.replay as boolean, operationId: row.operationId, requestFingerprint: row.requestFingerprint,
    graphRevision: row.graphRevision as number, nodeKey: row.nodeKey,
    dispatchDisposition: row.dispatchDisposition as TaskGraphNativeCommandReceipt["dispatchDisposition"], child: safeChild, ...(source ? { source } : {}),
  }
}

export async function appendNativeCoordination(input: Readonly<{
  context: ToolExecutionContext
  options: NativeCoordinationRuntimeOptions
  request: TaskGraphNativeRequest
  outputSchemaMarker?: TaskGraphNativeCommandInput["outputSchemaMarker"]
}>): Promise<Readonly<{ receipt: TaskGraphNativeCommandReceipt; rootTaskId: string }>> {
  const { context, options, request } = input
  if (!options.commandPort || typeof options.commandPort.appendNativeCoordination !== "function") {
    throw new CoordinationError("coordination_task_graph_native_coordination_unavailable", "Native TaskGraph coordination is unavailable")
  }
  const scope = executionScope(context, options)
  try {
    const raw = await options.commandPort.appendNativeCoordination({
      scope, request,
      ...(input.outputSchemaMarker ? { outputSchemaMarker: input.outputSchemaMarker } : {}),
    })
    const receipt = parseNativeCommandReceipt(raw, request.kind, scope.turnId)
    if (!receipt) throw new Error("native_receipt_invalid")
    if (receipt.child.rootTaskId !== scope.rootTaskId || receipt.child.parentTaskId !== scope.parentTaskId) throw new Error("native_receipt_scope_mismatch")
    return { receipt, rootTaskId: scope.rootTaskId }
  } catch (error: unknown) {
    if (isSessionPauseRequestedError(error)) throw error
    throw nativeError(error)
  }
}

export function nativeCoordinationOutput(
  operationKind: "spawn" | "followup",
  rootTaskId: string,
  receipt: TaskGraphNativeCommandReceipt,
) {
  return {
    taskId: receipt.child.taskId, rootTaskId: receipt.child.rootTaskId, parentTaskId: receipt.child.parentTaskId,
    path: receipt.child.path, depth: receipt.child.depth, status: receipt.child.status,
    replay: receipt.replay || receipt.status === "duplicate",
    nativeCoordination: {
      schemaVersion: NATIVE_COORDINATION_RECEIPT_SCHEMA, operationKind, status: receipt.status, replay: receipt.replay,
      operationId: receipt.operationId, requestFingerprint: receipt.requestFingerprint, graphRevision: receipt.graphRevision,
      nodeKey: receipt.nodeKey, dispatchDisposition: receipt.dispatchDisposition, rootTaskId, child: receipt.child,
    } satisfies NativeCoordinationReceipt,
  }
}

export function parseNativeCoordinationReceipt(value: unknown): NativeCoordinationReceipt | undefined {
  const row = record(value)
  if (!row || !exactKeys(row, "child,dispatchDisposition,graphRevision,nodeKey,operationId,operationKind,replay,requestFingerprint,rootTaskId,schemaVersion,status")
    || row.schemaVersion !== NATIVE_COORDINATION_RECEIPT_SCHEMA || (row.operationKind !== "spawn" && row.operationKind !== "followup")
    || !boundedText(row.operationId, 256) || typeof row.requestFingerprint !== "string" || !SHA256.test(row.requestFingerprint)
    || !boundedText(row.rootTaskId, 128)) return undefined
  const child = record(row.child)
  const commandReceipt = parseNativeCommandReceipt({
      status: row.status, replay: row.replay, operationId: row.operationId, requestFingerprint: row.requestFingerprint,
      graphRevision: row.graphRevision, nodeKey: row.nodeKey, dispatchDisposition: row.dispatchDisposition, child: row.child,
    }, row.operationKind)
  if (!child || !commandReceipt || commandReceipt.child.rootTaskId !== row.rootTaskId || commandReceipt.child.parentTaskId !== row.rootTaskId) return undefined
  return {
    schemaVersion: NATIVE_COORDINATION_RECEIPT_SCHEMA, operationKind: row.operationKind, status: row.status as TaskGraphNativeCommandReceipt["status"],
    replay: row.replay as boolean, operationId: row.operationId, requestFingerprint: row.requestFingerprint,
    graphRevision: commandReceipt.graphRevision, nodeKey: commandReceipt.nodeKey, dispatchDisposition: commandReceipt.dispatchDisposition,
    rootTaskId: row.rootTaskId, child: commandReceipt.child,
  }
}

export function nativeReceiptFromToolOutput(value: unknown): NativeCoordinationReceipt | undefined {
  const row = record(value)
  return row ? parseNativeCoordinationReceipt(row.nativeCoordination) : undefined
}

export function nativeReceiptFromToolCall(toolName: string, status: unknown, output: unknown): NativeCoordinationReceipt | null | false {
  if (!NATIVE_COORDINATION_TOOLS.has(toolName) || status !== "completed") return null
  const row = record(output)
  if (!row || !Object.hasOwn(row, "nativeCoordination")) return null
  return nativeReceiptFromToolOutput(row) ?? false
}

export function nativeCoordinationLifecycleOutput(value: unknown, expected: Readonly<{
  operationKind: "spawn" | "followup"; taskId: string; rootTaskId: string; parentTaskId: string | null
  path: string; depth: number; status: string; replay: boolean; sourceTaskId?: string
}>): RepositoryJsonValue | undefined {
  const row = record(value), native = parseNativeCoordinationReceipt(row?.nativeCoordination)
  if (!row || !native || native.operationKind !== expected.operationKind || native.rootTaskId !== expected.rootTaskId
    || native.child.taskId !== expected.taskId || native.child.rootTaskId !== expected.rootTaskId
    || native.child.parentTaskId !== expected.parentTaskId || native.child.path !== expected.path
    || native.child.depth !== expected.depth || native.child.status !== expected.status
    || (native.replay || native.status === "duplicate") !== expected.replay) return undefined
  const child = native.child
  const envelope: RepositoryJsonValue = {
    schemaVersion: native.schemaVersion, operationKind: native.operationKind, status: native.status, replay: native.replay,
    operationId: native.operationId, requestFingerprint: native.requestFingerprint, graphRevision: native.graphRevision,
    nodeKey: native.nodeKey, dispatchDisposition: native.dispatchDisposition, rootTaskId: native.rootTaskId,
    child: { taskId: child.taskId, rootTaskId: child.rootTaskId, parentTaskId: child.parentTaskId, path: child.path,
      depth: child.depth, role: child.role, taskType: child.taskType, status: child.status },
  }
  return { taskId: expected.taskId, rootTaskId: expected.rootTaskId, parentTaskId: expected.parentTaskId,
    path: expected.path, depth: expected.depth, status: expected.status, replay: expected.replay,
    ...(expected.sourceTaskId === undefined ? {} : { sourceTaskId: expected.sourceTaskId }), nativeCoordination: envelope }
}
