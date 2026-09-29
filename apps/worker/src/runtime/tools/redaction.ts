import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { canonicalJson, redactSensitiveText, redactSensitiveValue } from "@jobcopilot/shared"
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
const MAX_TASK_GRAPH_NODES = 8
const MAX_TASK_GRAPH_KEY_LENGTH = 128

/**
 * TaskGraph receipts are the one lifecycle result whose structural IDs must
 * survive text redaction: the model uses them to wait on the durable tasks.
 * Rebuild the exact receipt shape before returning it so no arbitrary fields
 * bypass the generic redactor.
 */
export function prepareTaskGraphPlanReceipt(value: unknown): PreparedLifecycleValue {
  const receipt = exactObject(value, PLAN_RECEIPT_FIELDS)
  if (receipt.status !== "accepted" && receipt.status !== "duplicate") throw invalidPlanReceipt()
  if (typeof receipt.revision !== "number" || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) throw invalidPlanReceipt()

  const inputNodes = denseArray(receipt.nodes, 1, MAX_TASK_GRAPH_NODES)
  const nodes: Array<{ key: string; taskId: string; status: "queued" | "waiting" }> = []
  const keys = new Set<string>()
  const taskIds = new Set<string>()
  for (const value of inputNodes) {
    const node = exactObject(value, PLAN_NODE_FIELDS)
    if (typeof node.key !== "string" || node.key.trim().length === 0 || node.key.length > MAX_TASK_GRAPH_KEY_LENGTH
      || redactSensitiveText(node.key) !== node.key) throw invalidPlanReceipt()
    if (typeof node.taskId !== "string" || !SUBAGENT_TASK_ID.test(node.taskId)) throw invalidPlanReceipt()
    if (node.status !== "queued" && node.status !== "waiting") throw invalidPlanReceipt()
    if (keys.has(node.key) || taskIds.has(node.taskId)) throw invalidPlanReceipt()
    keys.add(node.key)
    taskIds.add(node.taskId)
    nodes.push({ key: node.key, taskId: node.taskId, status: node.status })
  }

  const inputReadyTaskIds = denseArray(receipt.readyTaskIds, 0, MAX_TASK_GRAPH_NODES)
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

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidPlanReceipt()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw invalidPlanReceipt()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) throw invalidPlanReceipt()
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidPlanReceipt()
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

function invalidPlanReceipt(): Error {
  return new Error("task_graph_receipt_invalid")
}
