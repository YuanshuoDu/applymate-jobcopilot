export const OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC = "agent.objective-reviewed-fill.dispatch" as const
export const OBJECTIVE_REVIEWED_FILL_HANDOFF_SCHEMA = "agent-harness.v2.objective-reviewed-fill-handoff.v1" as const
export const OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA = "agent-harness.v2.objective-reviewed-fill-source.v1" as const

const APPROVED_EVENT_SCHEMA = "objective-application-review-approved-intent.v1"
const IDENTITY_KEYS = ["userId", "sessionId", "applicationTaskId", "approvalId", "predecessorTurnId"] as const
const INTENT_KEYS = ["schemaVersion", ...IDENTITY_KEYS] as const
const OUTBOX_KEYS = ["id", "topic", "aggregateId", "idempotencyKey", "payload"] as const
const APPROVED_KEYS = ["schemaVersion", "userId", "sessionId", "reviewTurnId", "applicationTaskId", "jobId",
  "approvalId", "setId", "slotOrdinal", "sourceTurnId", "materialProofHash"] as const
const SOURCE_KEYS = ["schemaVersion", "approvalId", "reviewTurnId", "materialProofHash"] as const
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SET_ID = /^objective-review-[a-f0-9]{40}$/
const APPROVAL_ID = /^objective-review:objective-review-[a-f0-9]{40}:[1-8]$/
const HASH = /^[a-f0-9]{64}$/

export type ObjectiveReviewedFillHandoffIdentity = Readonly<{
  userId: string
  sessionId: string
  applicationTaskId: string
  approvalId: string
  predecessorTurnId: string
}>
export type ObjectiveReviewedFillHandoffIntent = ObjectiveReviewedFillHandoffIdentity & Readonly<{
  schemaVersion: typeof OBJECTIVE_REVIEWED_FILL_HANDOFF_SCHEMA
}>
export type ObjectiveReviewedFillHandoffOutboxData = Readonly<{
  topic: typeof OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC
  aggregateId: string
  idempotencyKey: string
  payload: ObjectiveReviewedFillHandoffIntent
}>
export type ObjectiveReviewedFillHandoffOutboxRow = ObjectiveReviewedFillHandoffOutboxData & Readonly<{ id: string }>
export type ObjectiveReviewedFillSource = Readonly<{
  schemaVersion: typeof OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA
  approvalId: string
  reviewTurnId: string
  materialProofHash: string
}>
export type ObjectiveApplicationApprovedIntent = Readonly<{
  schemaVersion: typeof APPROVED_EVENT_SCHEMA
  userId: string
  sessionId: string
  reviewTurnId: string
  applicationTaskId: string
  jobId: string
  approvalId: string
  setId: string
  slotOrdinal: number
  sourceTurnId: string
  materialProofHash: string
}>

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null
    const result = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && value.trim() === value && ID.test(value)
}
function objectiveApprovalId(value: unknown): value is string { return typeof value === "string" && APPROVAL_ID.test(value) }
function slot(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 8 }

export function objectiveReviewedFillHandoffIdempotencyKey(approvalId: string): string | null {
  const key = `agent-objective-reviewed-fill:${approvalId}`
  return objectiveApprovalId(approvalId) && key.length <= 256 ? key : null
}

export function buildObjectiveReviewedFillHandoffOutboxData(
  input: ObjectiveReviewedFillHandoffIdentity,
): ObjectiveReviewedFillHandoffOutboxData | null {
  const identityFields = exactRecord(input, IDENTITY_KEYS)
  if (!identityFields || !IDENTITY_KEYS.every(field => identity(identityFields[field]))) return null
  const values = { schemaVersion: OBJECTIVE_REVIEWED_FILL_HANDOFF_SCHEMA, ...identityFields }
  const intent = exactRecord(values, INTENT_KEYS) as ObjectiveReviewedFillHandoffIntent | null
  const key = intent && objectiveReviewedFillHandoffIdempotencyKey(intent.approvalId)
  if (!intent || !key) return null
  return { topic: OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC, aggregateId: intent.sessionId, idempotencyKey: key, payload: intent }
}

export function parseObjectiveReviewedFillHandoffOutboxRow(value: unknown): ObjectiveReviewedFillHandoffOutboxRow | null {
  const row = exactRecord(value, OUTBOX_KEYS), payload = row && exactRecord(row.payload, INTENT_KEYS)
  const approvalId = payload?.approvalId
  const key = typeof approvalId === "string" ? objectiveReviewedFillHandoffIdempotencyKey(approvalId) : null
  const id = row?.id, sessionId = payload?.sessionId
  if (!row || !payload || payload.schemaVersion !== OBJECTIVE_REVIEWED_FILL_HANDOFF_SCHEMA || !key
    || !IDENTITY_KEYS.every(field => identity(payload[field])) || !identity(id) || !identity(sessionId)
    || row.topic !== OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC || row.aggregateId !== sessionId || row.idempotencyKey !== key) return null
  return { id, topic: OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC, aggregateId: sessionId,
    idempotencyKey: key, payload: payload as ObjectiveReviewedFillHandoffIntent }
}

/** Parses only the exact private selector; absence and malformed or legacy values both fail closed. */
export function parseObjectiveReviewedFillSource(input: unknown): ObjectiveReviewedFillSource | null {
  try {
    const envelope = record(input), descriptor = envelope && Object.getOwnPropertyDescriptor(envelope, "reviewedApplicationMaterialSource")
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    const source = exactRecord(descriptor.value, SOURCE_KEYS)
    if (!source || source.schemaVersion !== OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA || !objectiveApprovalId(source.approvalId)
      || !identity(source.reviewTurnId) || typeof source.materialProofHash !== "string" || !HASH.test(source.materialProofHash)) return null
    return source as ObjectiveReviewedFillSource
  } catch { return null }
}

export function parseObjectiveApplicationApprovedIntent(data: unknown): ObjectiveApplicationApprovedIntent | null {
  const intent = exactRecord(data, APPROVED_KEYS)
  if (!intent || intent.schemaVersion !== APPROVED_EVENT_SCHEMA || !APPROVED_KEYS.filter(key => key !== "schemaVersion"
    && key !== "slotOrdinal" && key !== "materialProofHash").every(key => identity(intent[key]))
    || !SET_ID.test(String(intent.setId)) || !slot(intent.slotOrdinal) || !objectiveApprovalId(intent.approvalId)
    || intent.approvalId !== `objective-review:${intent.setId}:${intent.slotOrdinal}`
    || intent.reviewTurnId === intent.sourceTurnId || typeof intent.materialProofHash !== "string"
    || !HASH.test(intent.materialProofHash)) return null
  return intent as ObjectiveApplicationApprovedIntent
}

/** Matches the deterministic private ApplicationTaskEvent row written by the Web approval transaction. */
export function objectiveApplicationApprovedIntentId(setId: string, slotOrdinal: number): string {
  return `objective-application-approved:${setId}:${slotOrdinal}`
}

function record(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}
