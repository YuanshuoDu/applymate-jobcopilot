import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { canonicalJson, redactSensitiveText, redactSensitiveValue } from "@jobcopilot/shared"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
export const DEFAULT_MAX_LIFECYCLE_BYTES = 8 * 1024

export interface ToolResultReference {
  readonly ref: string
  readonly sizeBytes: number
  readonly sha256: string
}
export interface ToolResultReferenceStore {
  put(value: RepositoryJsonValue): Promise<ToolResultReference>
}

export class InMemoryToolResultReferenceStore implements ToolResultReferenceStore {
  private readonly values = new Map<string, RepositoryJsonValue>()

  constructor(private readonly maxEntries = 256) {}

  async put(value: RepositoryJsonValue): Promise<ToolResultReference> {
    const encoded = canonicalJson(value)
    const sha256 = createHash("sha256").update(encoded, "utf8").digest("hex")
    const ref = `tool-result:${sha256.slice(0, 24)}`
    if (!this.values.has(ref) && this.values.size >= this.maxEntries) this.values.delete(this.values.keys().next().value as string)
    this.values.set(ref, value)
    return { ref, sizeBytes: Buffer.byteLength(encoded), sha256 }
  }

  get(ref: string): RepositoryJsonValue | undefined {
    return this.values.get(ref)
  }
}

export type PreparedLifecycleValue = {
  readonly safe: RepositoryJsonValue
  readonly encoded: string
  readonly sizeBytes: number
  readonly sha256: string
}

export function prepareLifecycleValue(value: unknown): PreparedLifecycleValue {
  const safe = redactSensitiveValue(value)
  return prepareSafeValue(safe)
}

const PLAN_RECEIPT_FIELDS = ["status", "revision", "nodes", "readyTaskIds"] as const
const PLAN_NODE_FIELDS = ["key", "taskId", "status"] as const
const SUBAGENT_TASK_ID = /^subagent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SPAWN_RECEIPT_FIELDS = ["taskId", "rootTaskId", "parentTaskId", "path", "depth", "status", "replay"] as const
const SPAWN_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const MAX_SUBAGENT_DEPTH = 8
const DURABLE_WAIT_ID = /^wait-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isDurableWaitId(value: unknown): value is string {
  return typeof value === "string" && DURABLE_WAIT_ID.test(value)
}

/**
 * TaskGraph and spawn receipts preserve generated structural IDs used by
 * later tool calls. Rebuild each exact receipt shape so arbitrary fields never
 * bypass the generic redactor.
 */
export function prepareTaskGraphPlanReceipt(value: unknown): PreparedLifecycleValue {
  const receipt = exactObject(value, PLAN_RECEIPT_FIELDS)
  if (receipt.status !== "accepted" && receipt.status !== "duplicate") throw invalidPlanReceipt()
  if (typeof receipt.revision !== "number" || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) throw invalidPlanReceipt()

  const inputNodes = denseArray(receipt.nodes, 1, TASK_GRAPH_LIMITS.maxNodes)
  const nodes: Array<{ key: string; taskId: string; status: "queued" | "waiting" }> = []
  const keys = new Set<string>()
  const taskIds = new Set<string>()
  for (const value of inputNodes) {
    const node = exactObject(value, PLAN_NODE_FIELDS)
    if (typeof node.key !== "string" || node.key.trim().length === 0 || node.key.length > TASK_GRAPH_LIMITS.maxKeyLength
      || redactSensitiveText(node.key) !== node.key) throw invalidPlanReceipt()
    if (typeof node.taskId !== "string" || !SUBAGENT_TASK_ID.test(node.taskId)) throw invalidPlanReceipt()
    if (node.status !== "queued" && node.status !== "waiting") throw invalidPlanReceipt()
    if (keys.has(node.key) || taskIds.has(node.taskId)) throw invalidPlanReceipt()
    keys.add(node.key)
    taskIds.add(node.taskId)
    nodes.push({ key: node.key, taskId: node.taskId, status: node.status })
  }

  const inputReadyTaskIds = denseArray(receipt.readyTaskIds, 0, TASK_GRAPH_LIMITS.maxNodes)
  const readyTaskIds = inputReadyTaskIds.map(value => {
    if (typeof value !== "string" || !SUBAGENT_TASK_ID.test(value)) throw invalidPlanReceipt()
    return value
  })
  const expectedReadyTaskIds = nodes.filter(node => node.status === "queued").map(node => node.taskId)
  if (readyTaskIds.length !== expectedReadyTaskIds.length || readyTaskIds.some((id, index) => id !== expectedReadyTaskIds[index])) {
    throw invalidPlanReceipt()
  }

  return prepareSafeValue({
    status: receipt.status,
    revision: receipt.revision,
    nodes,
    readyTaskIds,
  })
}

/**
 * Keeps only the runtime-generated lineage needed to wait for a spawned task.
 * The receipt must match the exact tool schema and the caller's trusted task
 * context before any identifier bypasses the generic phone redactor.
 */
export function prepareSubagentSpawnReceipt(
  value: unknown,
  identity: { readonly turnId: string; readonly taskId?: string; readonly rootTaskId?: string },
): PreparedLifecycleValue {
  const receipt = exactObject(value, SPAWN_RECEIPT_FIELDS, invalidSpawnReceipt)
  const { taskId, rootTaskId, parentTaskId, path, depth, status, replay } = receipt
  if (typeof identity.turnId !== "string" || !identity.turnId.trim() || identity.turnId.length > 256
    || (identity.taskId !== undefined && !isGeneratedTaskId(identity.taskId, identity.turnId))
    || (identity.rootTaskId !== undefined && !isGeneratedRootTaskId(identity.rootTaskId, identity.turnId))) throw invalidSpawnReceipt()
  if (!isSubagentTaskId(taskId)
    || typeof rootTaskId !== "string" || !isGeneratedRootTaskId(rootTaskId, identity.turnId)
    || (parentTaskId !== null && (typeof parentTaskId !== "string" || !isGeneratedTaskId(parentTaskId, identity.turnId)))
    || typeof path !== "string" || path.length === 0 || path.length > 2_048
    || typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0 || depth > MAX_SUBAGENT_DEPTH
    || typeof status !== "string" || !SPAWN_STATUSES.has(status) || typeof replay !== "boolean") throw invalidSpawnReceipt()

  const ownRoot = parentTaskId === null
  if (parentTaskId !== (identity.taskId ?? null)
    || (identity.rootTaskId !== undefined ? rootTaskId !== identity.rootTaskId : !ownRoot || rootTaskId !== taskId)
    || (ownRoot ? depth !== 0 || taskId !== rootTaskId : depth === 0)) throw invalidSpawnReceipt()

  const segments = path.startsWith("/") ? path.slice(1).split("/") : []
  if (segments.length !== depth + 1 || segments.some(segment => !segment)
    || segments[0] !== rootTaskId || segments.at(-1) !== taskId
    || (segments.length > 1 && segments.at(-2) !== parentTaskId)
    || (segments.length > 1 && segments.slice(1).some(segment => !isSubagentTaskId(segment)))
    || path !== `/${segments.join("/")}`) throw invalidSpawnReceipt()

  return prepareSafeValue({ taskId, rootTaskId, parentTaskId, path, depth, status, replay })
}

/** Preserves only a durable wait ID in an otherwise generically redacted result. */
export function prepareDurableWaitOutput(value: unknown): PreparedLifecycleValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return prepareLifecycleValue(value)
  const prototype = Object.getPrototypeOf(value)
  const waitId = Object.getOwnPropertyDescriptor(value, "waitId")
  if (waitId && ((prototype !== Object.prototype && prototype !== null) || !waitId.enumerable || !("value" in waitId))) {
    throw invalidWaitReceipt()
  }

  const prepared = prepareLifecycleValue(value)
  if (prepared.safe === null || typeof prepared.safe !== "object" || Array.isArray(prepared.safe)) {
    if (waitId) throw invalidWaitReceipt()
    return prepared
  }
  const safeWaitId = waitId && isDurableWaitId(waitId.value) ? waitId.value : "[REDACTED]"
  if (prepared.safe.status === "waiting" && safeWaitId === "[REDACTED]") throw invalidWaitReceipt()
  if (!waitId) return prepared
  return prepareSafeValue({ ...prepared.safe, waitId: safeWaitId })
}

export function sanitizeLifecyclePreview(value: unknown, maxBytes = DEFAULT_MAX_LIFECYCLE_BYTES): RepositoryJsonValue {
  const prepared = prepareLifecycleValue(value)
  if (prepared.sizeBytes <= maxBytes) return prepared.safe
  return {
    $truncated: true,
    sizeBytes: prepared.sizeBytes,
    sha256: prepared.sha256,
    summary: "Payload omitted from the lifecycle event because it exceeds its inline byte limit",
  }
}

export async function sanitizeForLifecycle(
  value: unknown,
  _references: ToolResultReferenceStore,
  maxBytes = DEFAULT_MAX_LIFECYCLE_BYTES,
): Promise<RepositoryJsonValue> {
  return sanitizeLifecyclePreview(value, maxBytes)
}

function prepareSafeValue(safe: RepositoryJsonValue): PreparedLifecycleValue {
  const encoded = canonicalJson(safe)
  return {
    safe,
    encoded,
    sizeBytes: Buffer.byteLength(encoded, "utf8"),
    sha256: createHash("sha256").update(encoded, "utf8").digest("hex"),
  }
}

function exactObject(value: unknown, fields: readonly string[], invalid = invalidPlanReceipt): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) throw invalid()
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid()
  }
  return value as Record<string, unknown>
}

function denseArray(value: unknown, minLength: number, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) throw invalidPlanReceipt()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))) {
    throw invalidPlanReceipt()
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidPlanReceipt()
  }
  return value
}

function isSubagentTaskId(value: unknown): value is string {
  return typeof value === "string" && SUBAGENT_TASK_ID.test(value)
}

function isGeneratedRootTaskId(value: unknown, turnId: string): value is string {
  return isSubagentTaskId(value) || value === `root-${turnId}`
}

function isGeneratedTaskId(value: unknown, turnId: string): value is string {
  return isGeneratedRootTaskId(value, turnId)
}

function invalidSpawnReceipt(): Error {
  return new Error("subagent_spawn_receipt_invalid")
}

function invalidWaitReceipt(): Error {
  return new Error("durable_wait_receipt_invalid")
}

function invalidPlanReceipt(): Error {
  return new Error("task_graph_receipt_invalid")
}
