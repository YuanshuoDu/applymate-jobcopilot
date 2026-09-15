import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

export type AgentOutboxPayload = {
  readonly eventId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly itemId: string | null
  readonly sequence: string
  readonly type: string
  readonly actor: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly idempotencyKey: string
  readonly payload: RepositoryJsonValue
}

export type AgentOutboxIdentity = {
  readonly id: string
  readonly topic: string
  readonly aggregateId: string
  readonly idempotencyKey: string
  readonly payload: AgentOutboxPayload
}

type Row = Record<string, unknown>

function plain(value: unknown): value is Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const row = value as Row
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError("undefined is not JSON")
  return serialized
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

/** Compare every server-owned outbox column and envelope field, ignoring JSON key order. */
export function matchesAgentOutboxIdentity(value: unknown, expected: AgentOutboxIdentity): boolean {
  if (!plain(value) || String(value.id) !== expected.id || value.topic !== expected.topic || value.aggregateId !== expected.aggregateId || value.idempotencyKey !== expected.idempotencyKey) return false
  const payload = parsePayload(value.payload)
  if (!plain(payload)) return false
  try { return stableJson(payload) === stableJson(expected.payload) } catch { return false }
}
