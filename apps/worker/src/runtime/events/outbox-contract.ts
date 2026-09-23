import type { AgentEventRecord, Actor, RepositoryJsonValue } from "@jobcopilot/agent-protocol"

export type AgentEventRow = {
  id: string
  sessionId: string
  turnId: string | null
  itemId: string | null
  taskId: string | null
  sequence: bigint | string | number
  type: string
  actor: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  payload: unknown
  createdAt: Date | string
}

export type AgentEventOutboxPayload = {
  eventId: string
  sessionId: string
  turnId?: string | null
  itemId?: string | null
  taskId?: string | null
  sequence?: string
  type?: string
  actor?: Actor
  correlationId?: string
  causationId?: string | null
  idempotencyKey?: string | null
  payload?: RepositoryJsonValue
}

const PAYLOAD_KEYS = new Set([
  "actor", "causationId", "correlationId", "eventId", "idempotencyKey", "itemId", "payload", "sequence", "sessionId", "taskId", "turnId", "type",
])
const ACTORS = new Set<Actor>(["user", "orchestrator", "subagent", "tool", "system"])

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function jsonValue(value: unknown): value is RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  return record(value) && Object.values(value).every(jsonValue)
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function nullableId(value: unknown): value is string | null { return value === null || nonEmpty(value) }
function hasOwn(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key) }

function sequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null
  try { return BigInt(value) } catch { return null }
}

export function parseAgentEventOutboxPayload(value: unknown): AgentEventOutboxPayload | null {
  const parsed = parseJson(value)
  if (!record(parsed) || Object.keys(parsed).some(key => !PAYLOAD_KEYS.has(key))) return null
  const row = parsed
  if (!hasOwn(row, "eventId") || !hasOwn(row, "sessionId") || !nonEmpty(row.eventId) || !nonEmpty(row.sessionId)) return null
  const result: AgentEventOutboxPayload = { eventId: row.eventId, sessionId: row.sessionId }
  if (hasOwn(row, "turnId")) {
    if (!nullableId(row.turnId)) return null
    result.turnId = row.turnId
  }
  if (hasOwn(row, "itemId")) {
    if (!nullableId(row.itemId)) return null
    result.itemId = row.itemId
  }
  if (hasOwn(row, "taskId")) {
    if (!nullableId(row.taskId)) return null
    result.taskId = row.taskId
  }
  if (hasOwn(row, "sequence")) {
    const parsedSequence = sequence(row.sequence)
    if (parsedSequence === null) return null
    result.sequence = parsedSequence.toString()
  }
  if (hasOwn(row, "type")) {
    if (!nonEmpty(row.type)) return null
    result.type = row.type
  }
  if (hasOwn(row, "actor")) {
    if (typeof row.actor !== "string" || !ACTORS.has(row.actor as Actor)) return null
    result.actor = row.actor as Actor
  }
  if (hasOwn(row, "correlationId")) {
    if (!nonEmpty(row.correlationId)) return null
    result.correlationId = row.correlationId
  }
  if (hasOwn(row, "causationId")) {
    if (!nullableId(row.causationId)) return null
    result.causationId = row.causationId
  }
  if (hasOwn(row, "idempotencyKey")) {
    if (!nullableId(row.idempotencyKey)) return null
    result.idempotencyKey = row.idempotencyKey
  }
  if (hasOwn(row, "payload")) {
    if (!jsonValue(row.payload)) return null
    result.payload = row.payload
  }
  return result
}

export function toCanonicalAgentEvent(row: AgentEventRow): AgentEventRecord | null {
  const parsedSequence = sequence(row.sequence)
  const payload = parseJson(row.payload)
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
  if (!nonEmpty(row.id) || !nonEmpty(row.sessionId) || !nullableId(row.turnId) || !nullableId(row.itemId) || !nullableId(row.taskId)
    || parsedSequence === null || !nonEmpty(row.type) || typeof row.actor !== "string" || !ACTORS.has(row.actor as Actor)
    || !nonEmpty(row.correlationId) || !nullableId(row.causationId) || !nullableId(row.idempotencyKey) || !jsonValue(payload)
    || typeof createdAt !== "string" || !Number.isFinite(new Date(createdAt).getTime())) return null
  return { ...row, sequence: parsedSequence, actor: row.actor as Actor, payload, createdAt }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError("value is not JSON")
  return serialized
}

export function matchesCanonicalAgentEvent(event: AgentEventRecord, payload: AgentEventOutboxPayload): boolean {
  if (event.id !== payload.eventId || event.sessionId !== payload.sessionId) return false
  if (hasOwn(payload, "turnId") && event.turnId !== payload.turnId) return false
  if (hasOwn(payload, "itemId") && event.itemId !== payload.itemId) return false
  if (hasOwn(payload, "taskId") && event.taskId !== payload.taskId) return false
  if (hasOwn(payload, "sequence") && event.sequence.toString() !== payload.sequence) return false
  if (hasOwn(payload, "type") && event.type !== payload.type) return false
  if (hasOwn(payload, "actor") && event.actor !== payload.actor) return false
  if (hasOwn(payload, "correlationId") && event.correlationId !== payload.correlationId) return false
  if (hasOwn(payload, "causationId") && event.causationId !== payload.causationId) return false
  if (hasOwn(payload, "idempotencyKey") && event.idempotencyKey !== payload.idempotencyKey) return false
  if (hasOwn(payload, "payload")) {
    try { return stableJson(event.payload) === stableJson(payload.payload) } catch { return false }
  }
  return true
}
