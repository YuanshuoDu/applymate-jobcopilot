export const REVIEWED_FILL_HANDOFF_TOPIC = "agent.reviewed-fill.dispatch" as const
export const REVIEWED_FILL_HANDOFF_SCHEMA = "agent-harness.v2.reviewed-fill-handoff.v1" as const
const IDENTITY_KEYS = ["userId", "sessionId", "applicationTaskId", "approvalId", "predecessorTurnId"] as const
const INTENT_KEYS = ["schemaVersion", ...IDENTITY_KEYS] as const
const OUTBOX_KEYS = ["id", "topic", "aggregateId", "idempotencyKey", "payload"] as const

export type ReviewedFillHandoffIdentity = Readonly<{
  userId: string
  sessionId: string
  applicationTaskId: string
  approvalId: string
  predecessorTurnId: string
}>

export type ReviewedFillHandoffIntent = ReviewedFillHandoffIdentity & Readonly<{
  schemaVersion: typeof REVIEWED_FILL_HANDOFF_SCHEMA
}>

export type ReviewedFillHandoffOutboxData = Readonly<{
  topic: typeof REVIEWED_FILL_HANDOFF_TOPIC
  aggregateId: string
  idempotencyKey: string
  payload: ReviewedFillHandoffIntent
}>

export type ReviewedFillHandoffOutboxRow = ReviewedFillHandoffOutboxData & Readonly<{ id: string }>

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null
    const output = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
      output[key] = descriptor.value
    }
    return output
  } catch {
    return null
  }
}

export function parseReviewedFillHandoffIntent(value: unknown): ReviewedFillHandoffIntent | null {
  const intent = exactRecord(value, INTENT_KEYS)
  if (!intent || intent.schemaVersion !== REVIEWED_FILL_HANDOFF_SCHEMA
    || !IDENTITY_KEYS.every(key => isIdentity(intent[key])) || !isIdentity(intent.approvalId)
    || !reviewedFillHandoffIdempotencyKey(intent.approvalId)) return null
  return intent as ReviewedFillHandoffIntent
}

export function buildReviewedFillHandoffIntent(input: ReviewedFillHandoffIdentity): ReviewedFillHandoffIntent | null {
  return parseReviewedFillHandoffIntent({ schemaVersion: REVIEWED_FILL_HANDOFF_SCHEMA, ...input })
}

export function reviewedFillHandoffIdempotencyKey(approvalId: string): string | null {
  const key = `agent-reviewed-fill:${approvalId}`
  return isIdentity(approvalId) && key.length <= 256 ? key : null
}

export function buildReviewedFillHandoffOutboxData(input: ReviewedFillHandoffIdentity): ReviewedFillHandoffOutboxData | null {
  const payload = buildReviewedFillHandoffIntent(input)
  const idempotencyKey = payload ? reviewedFillHandoffIdempotencyKey(payload.approvalId) : null
  if (!payload || !idempotencyKey) return null
  return { topic: REVIEWED_FILL_HANDOFF_TOPIC, aggregateId: payload.sessionId, idempotencyKey, payload }
}

/** Parses only the selected row fields and rebinds its topic, Session aggregate, key and closed payload. */
export function parseReviewedFillHandoffOutboxRow(value: unknown): ReviewedFillHandoffOutboxRow | null {
  const row = exactRecord(value, OUTBOX_KEYS)
  const payload = parseReviewedFillHandoffIntent(row?.payload)
  const expectedKey = payload ? reviewedFillHandoffIdempotencyKey(payload.approvalId) : null
  if (!row || !payload || !expectedKey || !isIdentity(row.id) || row.topic !== REVIEWED_FILL_HANDOFF_TOPIC
    || row.aggregateId !== payload.sessionId || row.idempotencyKey !== expectedKey) return null
  return { id: row.id, topic: REVIEWED_FILL_HANDOFF_TOPIC, aggregateId: payload.sessionId,
    idempotencyKey: expectedKey, payload }
}
