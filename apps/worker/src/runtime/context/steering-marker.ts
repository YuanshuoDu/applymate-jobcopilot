import { Buffer } from "node:buffer"

export const STEERING_MARKER_SCHEMA_VERSION = "agent-harness.steering-marker.v1" as const
export const STEERING_MARKER_EVENT_TYPE = "agent.steering.marker" as const
export const STEERING_MARKER_MAX_EVENTS = 128
export const STEERING_MARKER_MAX_BYTES = 16 * 1024
const MAX_ID = 96
const MAX_KEY = 512
const MAX_SEQUENCE_DIGITS = 20
const STATUSES = ["observed", "applied"] as const
type MarkerStatus = (typeof STATUSES)[number]

export type SteeringMarkerPayload = {
  readonly schemaVersion: typeof STEERING_MARKER_SCHEMA_VERSION
  readonly kind: MarkerStatus
  readonly status: MarkerStatus
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly stepId: string
  readonly inputId: string
  readonly idempotencyKey: string
  readonly obligationId: string | null
  readonly goalRevision: number
  readonly planRevision: number | null
  readonly acceptedSequence: string
}

export type SteeringMarkerScope = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
}

export type SteeringMarkerEvent = {
  readonly id: string
  readonly type: typeof STEERING_MARKER_EVENT_TYPE
  readonly actor: "system"
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly sequence: string | number | bigint
  readonly payload: unknown
}

export type SteeringMarkerReductionOptions = { readonly throughSequence?: string }
export type SteeringMarkerState = {
  readonly observed: readonly SteeringMarkerPayload[]
  readonly applied: readonly SteeringMarkerPayload[]
  readonly active: readonly SteeringMarkerPayload[]
}
export type SteeringMarkerReduction =
  | { readonly valid: true; readonly state: SteeringMarkerState }
  | { readonly valid: false; readonly reason: string }

type Row = Record<string, unknown>
type ParsedEvent = { readonly id: string; readonly sequence: string; readonly payload: SteeringMarkerPayload }

function plain(value: unknown): value is Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function exactKeys(value: Row, expected: readonly string[]): boolean {
  if (Object.keys(value).length !== expected.length) return false
  const accepted = new Set(expected)
  return Object.keys(value).every(key => accepted.has(key))
}
function safeText(value: unknown, max = MAX_ID): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value) && !/\b(?:password|secret|token|api[_-]?key|authorization)\b/i.test(value)
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}
function decimal(value: unknown, allowBigInt = false): string | null {
  if (typeof value === "bigint") {
    if (!allowBigInt || value < 0n) return null
    value = value.toString()
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null
    value = String(value)
  }
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && value.length <= MAX_SEQUENCE_DIGITS ? value : null
}
function less(left: string, right: string): boolean { return BigInt(left) < BigInt(right) }
function jsonBytes(value: unknown): number | null {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") } catch { return null }
}

export function steeringMarkerIdempotencyKey(input: Pick<SteeringMarkerPayload, "sessionId" | "turnId" | "inputId">): string
export function steeringMarkerIdempotencyKey(sessionId: string, turnId: string, inputId: string): string
export function steeringMarkerIdempotencyKey(first: Pick<SteeringMarkerPayload, "sessionId" | "turnId" | "inputId"> | string, turnId?: string, inputId?: string): string {
  const sessionId = typeof first === "string" ? first : first.sessionId
  const resolvedTurnId = typeof first === "string" ? turnId : first.turnId
  const resolvedInputId = typeof first === "string" ? inputId : first.inputId
  return `steering-marker:${sessionId}:${resolvedTurnId}:${resolvedInputId}`
}

const PAYLOAD_KEYS = ["schemaVersion", "kind", "status", "sessionId", "turnId", "taskId", "stepId", "inputId", "idempotencyKey", "obligationId", "goalRevision", "planRevision", "acceptedSequence"] as const

export function parseSteeringMarkerPayload(value: unknown): SteeringMarkerPayload | null {
  if (!plain(value) || !exactKeys(value, PAYLOAD_KEYS) || value.schemaVersion !== STEERING_MARKER_SCHEMA_VERSION) return null
  if (!STATUSES.includes(value.kind as MarkerStatus) || value.status !== value.kind) return null
  if (!["sessionId", "turnId", "taskId", "stepId", "inputId"].every(field => safeText(value[field]))) return null
  if (value.obligationId !== null && !safeText(value.obligationId)) return null
  if (!revision(value.goalRevision) || value.planRevision !== null && !revision(value.planRevision)) return null
  if (!safeText(value.idempotencyKey, MAX_KEY) || value.idempotencyKey !== steeringMarkerIdempotencyKey(value.sessionId as string, value.turnId as string, value.inputId as string)) return null
  if (!safeText(value.acceptedSequence, MAX_SEQUENCE_DIGITS) || decimal(value.acceptedSequence) === null) return null
  return {
    schemaVersion: STEERING_MARKER_SCHEMA_VERSION, kind: value.kind as MarkerStatus, status: value.status as MarkerStatus,
    sessionId: value.sessionId as string, turnId: value.turnId as string, taskId: value.taskId as string,
    stepId: value.stepId as string, inputId: value.inputId as string, idempotencyKey: value.idempotencyKey as string,
    obligationId: value.obligationId as string | null, goalRevision: value.goalRevision as number,
    planRevision: value.planRevision as number | null, acceptedSequence: value.acceptedSequence as string,
  }
}

const EVENT_KEYS = ["id", "type", "actor", "userId", "sessionId", "turnId", "taskId", "sequence", "payload"] as const
function parseEvent(value: unknown, scope: SteeringMarkerScope, throughSequence: string | undefined): ParsedEvent | null {
  if (!plain(value) || !exactKeys(value, EVENT_KEYS) || value.type !== STEERING_MARKER_EVENT_TYPE || value.actor !== "system") return null
  if (!["id", "userId", "sessionId", "turnId", "taskId"].every(field => safeText(value[field]))) return null
  if (value.userId !== scope.userId || value.sessionId !== scope.sessionId || value.turnId !== scope.turnId || value.taskId !== scope.taskId) return null
  const sequence = decimal(value.sequence, true), payload = parseSteeringMarkerPayload(value.payload)
  if (!sequence || !payload || payload.sessionId !== scope.sessionId || payload.turnId !== scope.turnId || payload.taskId !== scope.taskId) return null
  if (less(sequence, payload.acceptedSequence)) return null
  if (throughSequence !== undefined && less(throughSequence, sequence)) return null
  return { id: value.id as string, sequence, payload }
}

function comparable(payload: SteeringMarkerPayload): string {
  return JSON.stringify({ schemaVersion: payload.schemaVersion, sessionId: payload.sessionId, turnId: payload.turnId, taskId: payload.taskId, inputId: payload.inputId, idempotencyKey: payload.idempotencyKey, obligationId: payload.obligationId, goalRevision: payload.goalRevision, planRevision: payload.planRevision, acceptedSequence: payload.acceptedSequence })
}
function invalid(reason: string): SteeringMarkerReduction { return { valid: false, reason } }

export function reduceSteeringMarkers(events: readonly SteeringMarkerEvent[], scope: SteeringMarkerScope, options: SteeringMarkerReductionOptions = {}): SteeringMarkerReduction {
  if (!plain(scope) || !safeText(scope.userId) || !safeText(scope.sessionId) || !safeText(scope.turnId) || !safeText(scope.taskId)) return invalid("invalid_scope")
  const parsedThroughSequence = options.throughSequence === undefined ? undefined : decimal(options.throughSequence)
  if (options.throughSequence !== undefined && !parsedThroughSequence) return invalid("invalid_through_sequence")
  const throughSequence = parsedThroughSequence ?? undefined
  if (!Array.isArray(events) || events.length > STEERING_MARKER_MAX_EVENTS) return invalid("event_limit")
  const parsed: ParsedEvent[] = [], eventIds = new Map<string, string>(), eventSequences = new Map<string, string>()
  let bytes = 0
  for (const event of events) {
    const row = parseEvent(event, scope, throughSequence)
    if (!row) return invalid("invalid_event")
    const eventFingerprint = `${row.sequence}:${comparable(row.payload)}:${row.payload.kind}:${row.payload.stepId}`
    const prior = eventIds.get(row.id)
    if (prior !== undefined) { if (prior !== eventFingerprint) return invalid("event_conflict"); continue }
    const priorId = eventSequences.get(row.sequence)
    if (priorId !== undefined && priorId !== row.id) return invalid("sequence_conflict")
    eventIds.set(row.id, eventFingerprint); eventSequences.set(row.sequence, row.id)
    bytes += jsonBytes(row) ?? STEERING_MARKER_MAX_BYTES
    if (bytes > STEERING_MARKER_MAX_BYTES) return invalid("byte_limit")
    parsed.push(row)
  }
  parsed.sort((left, right) => { const sequence = BigInt(left.sequence) - BigInt(right.sequence); return sequence === 0n ? left.id.localeCompare(right.id) : sequence < 0n ? -1 : 1 })
  const entries = new Map<string, { observed: SteeringMarkerPayload; applied?: SteeringMarkerPayload }>()
  for (const event of parsed) {
    const key = event.payload.idempotencyKey, existing = entries.get(key)
    if (!existing) {
      if (event.payload.kind === "applied") return invalid("orphan_applied")
      entries.set(key, { observed: event.payload }); continue
    }
    if (comparable(existing.observed) !== comparable(event.payload)) return invalid("marker_conflict")
    if (event.payload.kind === "observed") { if (existing.applied) return invalid("observed_after_applied"); continue }
    if (!existing.applied) existing.applied = event.payload
    else if (comparable(existing.applied) !== comparable(event.payload)) return invalid("applied_conflict")
  }
  const ordered = [...entries.values()].sort((left, right) => left.observed.idempotencyKey.localeCompare(right.observed.idempotencyKey))
  return { valid: true, state: { observed: ordered.map(entry => entry.observed), applied: ordered.flatMap(entry => entry.applied ? [entry.applied] : []), active: ordered.flatMap(entry => entry.applied ? [] : [entry.observed]) } }
}
