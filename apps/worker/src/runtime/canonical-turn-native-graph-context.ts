import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type {
  TaskGraphCurrentNode,
  TaskGraphCurrentState,
  TaskGraphNativeNodeView,
  TaskGraphNativeResultReceipt,
} from "./subagents/task-graph-command-port.js"
import { nativeReceiptFromToolOutput, type NativeCoordinationReceipt } from "./tools/task-graph-coordination-bridge.js"

const SHA256 = /^[a-f0-9]{64}$/
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const TERMINAL_SOURCE_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
const COORDINATION_TOOL_NAMES = new Set(["agent.spawn", "spawn_subagent", "agent.followup"])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : null
}
function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join(",") === keys
}
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
}
function safeSource(value: unknown): TaskGraphNativeNodeView["source"] | undefined {
  const source = record(value)
  if (!source || !exactKeys(source, "attemptCount,graphNodeKey,origin,parentTaskId,resultDigest,role,rootTaskId,status,taskId,taskType,turnId")
    || !boundedText(source.taskId, 128) || !boundedText(source.rootTaskId, 128)
    || !(source.parentTaskId === null || boundedText(source.parentTaskId, 128))
    || !boundedText(source.turnId, 128) || !boundedText(source.role, 64) || !boundedText(source.taskType, 128)
    || typeof source.status !== "string" || !TERMINAL_SOURCE_STATUSES.has(source.status)
    || !Number.isSafeInteger(source.attemptCount) || Number(source.attemptCount) < 0
    || typeof source.resultDigest !== "string" || !SHA256.test(source.resultDigest)
    || !(source.graphNodeKey === null || boundedText(source.graphNodeKey, 128))
    || (source.origin !== "task_graph" && source.origin !== "native_legacy")) return undefined
  return {
    taskId: source.taskId, rootTaskId: source.rootTaskId, parentTaskId: source.parentTaskId as string | null,
    turnId: source.turnId, role: source.role, taskType: source.taskType,
    status: source.status as NonNullable<TaskGraphNativeNodeView["source"]>["status"],
    attemptCount: source.attemptCount as number, resultDigest: source.resultDigest,
    graphNodeKey: source.graphNodeKey as string | null, origin: source.origin,
  }
}

function safeNative(value: unknown): TaskGraphNativeNodeView | undefined {
  const native = record(value)
  if (!native || !(exactKeys(native, "callerTaskId,contextDigest,operationId,operationKind,requestFingerprint,role,taskType")
      || exactKeys(native, "callerTaskId,contextDigest,operationId,operationKind,requestFingerprint,role,source,taskType"))
    || (native.operationKind !== "spawn" && native.operationKind !== "followup")
    || !boundedText(native.operationId, 256) || typeof native.requestFingerprint !== "string" || !SHA256.test(native.requestFingerprint)
    || !boundedText(native.callerTaskId, 128) || !boundedText(native.role, 64) || !boundedText(native.taskType, 128)
    || typeof native.contextDigest !== "string" || !SHA256.test(native.contextDigest)) return undefined
  const source = Object.hasOwn(native, "source") ? safeSource(native.source) : undefined
  if (Object.hasOwn(native, "source") && !source || native.operationKind === "followup" && !source) return undefined
  return {
    operationKind: native.operationKind, operationId: native.operationId, requestFingerprint: native.requestFingerprint,
    callerTaskId: native.callerTaskId, role: native.role, taskType: native.taskType, contextDigest: native.contextDigest,
    ...(source ? { source } : {}),
  }
}

function safeNativeResult(value: unknown): TaskGraphNativeResultReceipt | undefined {
  const result = record(value)
  if (!result || !exactKeys(result, "disposition,resultDigest,role,schemaVersion,taskStatus")
    || result.schemaVersion !== "agent-harness.v2.task-graph.native-result.v1" || !boundedText(result.role, 64)
    || typeof result.taskStatus !== "string" || !TASK_STATUSES.has(result.taskStatus)
    || (result.disposition !== "structured" && result.disposition !== "opaque" && result.disposition !== "missing")
    || !(result.resultDigest === null || typeof result.resultDigest === "string" && SHA256.test(result.resultDigest))) return undefined
  return {
    schemaVersion: "agent-harness.v2.task-graph.native-result.v1", role: result.role,
    taskStatus: result.taskStatus as TaskGraphNativeResultReceipt["taskStatus"],
    disposition: result.disposition, resultDigest: result.resultDigest as string | null,
  }
}

/** Parse only the safe native graph read model; execution context and raw results stay private. */
export function nativeGraphNodeFields(value: Record<string, unknown>): Pick<TaskGraphCurrentNode, "native" | "nativeResult"> {
  const hasNative = Object.hasOwn(value, "native"), hasResult = Object.hasOwn(value, "nativeResult")
  const native = hasNative ? safeNative(value.native) : undefined
  const nativeResult = hasResult ? safeNativeResult(value.nativeResult) : undefined
  if (hasNative && !native || hasResult && !nativeResult || nativeResult && (!native || native.role !== nativeResult.role)) {
    throw new Error("task_graph_current_state_invalid:native")
  }
  return { ...(native ? { native } : {}), ...(nativeResult ? { nativeResult } : {}) }
}

/** Read server-generated native receipts from durable tool results after recovery. */
export function nativeCoordinationReceipts(snapshot: StepContextSnapshot): readonly NativeCoordinationReceipt[] {
  const receipts = new Map<string, NativeCoordinationReceipt>()
  for (const observation of snapshot.toolObservations) {
    const content = record(observation.content)
    if (!content || typeof content.toolName !== "string" || !COORDINATION_TOOL_NAMES.has(content.toolName) || content.status !== "completed") continue
    const output = record(content.output)
    if (output && Object.hasOwn(output, "nativeCoordination")) {
      const receipt = nativeReceiptFromToolOutput(output)
      if (!receipt) throw new Error("native_coordination_receipt_invalid")
      const previous = receipts.get(receipt.operationId)
      if (previous && (previous.requestFingerprint !== receipt.requestFingerprint || previous.nodeKey !== receipt.nodeKey || previous.child.taskId !== receipt.child.taskId)) {
        throw new Error("native_coordination_receipt_conflict")
      }
      receipts.set(receipt.operationId, receipt)
    }
  }
  return [...receipts.values()]
}

/** Tie the durable tool receipt to immutable current graph ownership and operation identity. */
export function nativeReceiptsMatchGraph(
  receipts: readonly NativeCoordinationReceipt[], state: TaskGraphCurrentState, rootTaskId: string,
): boolean {
  if (receipts.length === 0) return true
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.nodes)) return false
  return receipts.every(receipt => {
    if (receipt.rootTaskId !== rootTaskId || receipt.child.rootTaskId !== rootTaskId || state.revision < receipt.graphRevision) return false
    const matches = state.nodes.filter(node => node.key === receipt.nodeKey && node.taskId === receipt.child.taskId)
    if (matches.length !== 1) return false
    const node = matches[0]!, native = node.native
    return Boolean(native && native.operationKind === receipt.operationKind && native.operationId === receipt.operationId
      && native.requestFingerprint === receipt.requestFingerprint && native.callerTaskId === rootTaskId
      && native.role === receipt.child.role && native.taskType === receipt.child.taskType)
  })
}
