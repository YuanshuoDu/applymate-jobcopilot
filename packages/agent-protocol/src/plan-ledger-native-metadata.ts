const NATIVE_NODE_KEYS = "dependsOn,depth,goal,key,nativeDelegation,successCriteria,taskId,templateId,verificationDisposition"
const NATIVE_VERSION = "agent-harness.v2.task-graph.native-delegation.v1"
const HASH = /^[a-f0-9]{64}$/
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])

/** Structural-only recognition for the persisted #570 native node shape. */
export function isStrictNativeTaskGraphNode(value: unknown): boolean {
  if (!record(value) || !exact(value, NATIVE_NODE_KEYS) || value.templateId !== "native"
    || value.verificationDisposition !== "legacy_unverified") return false
  return nativeDelegation(value.nativeDelegation)
}

function nativeDelegation(value: unknown): boolean {
  if (!record(value)) return false
  const hasSource = Object.hasOwn(value, "source")
  const keys = hasSource
    ? "callerTaskId,contextBytes,contextDigest,operationId,operationKind,requestFingerprint,role,schemaVersion,source,taskType"
    : "callerTaskId,contextBytes,contextDigest,operationId,operationKind,requestFingerprint,role,schemaVersion,taskType"
  if (!exact(value, keys) || value.schemaVersion !== NATIVE_VERSION
    || (value.operationKind !== "spawn" && value.operationKind !== "followup")
    || !id(value.operationId) || typeof value.requestFingerprint !== "string" || !HASH.test(value.requestFingerprint) || !sourceId(value.callerTaskId)
    || !label(value.role, 64) || !label(value.taskType, 128) || typeof value.contextDigest !== "string" || !HASH.test(value.contextDigest)
    || !Number.isSafeInteger(value.contextBytes) || Number(value.contextBytes) < 0 || Number(value.contextBytes) > 40_000) return false
  if (value.operationKind === "spawn") return !hasSource
  const source = hasSource ? sourceMetadata(value.source) : null
  return source !== null && source.role === value.role && source.taskType === value.taskType
}

function sourceMetadata(value: unknown): Readonly<{ role: string; taskType: string }> | null {
  if (!record(value) || !exact(value, "attemptCount,graphNodeKey,origin,parentTaskId,resultDigest,role,rootTaskId,status,taskId,taskType,turnId")
    || !sourceId(value.taskId) || !sourceId(value.rootTaskId)
    || !(value.parentTaskId === null || sourceId(value.parentTaskId)) || !sourceId(value.turnId)
    || !label(value.role, 64) || !label(value.taskType, 128) || typeof value.status !== "string" || !TERMINAL.has(value.status)
    || !Number.isSafeInteger(value.attemptCount) || Number(value.attemptCount) < 0
    || typeof value.resultDigest !== "string" || !HASH.test(value.resultDigest)
    || !(value.graphNodeKey === null || id(value.graphNodeKey))
    || (value.origin !== "task_graph" && value.origin !== "native_legacy")
    || (value.origin === "task_graph" && value.graphNodeKey === null)
    || (value.origin === "native_legacy" && value.graphNodeKey !== null)) return null
  return { role: value.role as string, taskType: value.taskType as string }
}

function record(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
    return Reflect.ownKeys(value).every(key => typeof key === "string" && (() => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, "value"))
    })())
  } catch { return false }
}

function exact(value: Record<string, unknown>, keys: string): boolean {
  return Reflect.ownKeys(value).sort().join(",") === keys
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128
}

function sourceId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}

function label(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
}
