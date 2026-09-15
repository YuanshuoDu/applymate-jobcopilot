import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

export const STEERING_MARKER_SCHEMA_VERSION = 'agent-harness.steering-marker.v1' as const
export const STEERING_MARKER_EVENT_TYPE = 'agent.steering.marker' as const
export const STEERING_MARKER_MAX_EVENTS = 128
export const STEERING_MARKER_MAX_BYTES = 16 * 1024

const MAX_ID_BYTES = 96
const MAX_KEY_BYTES = 512
const MAX_SEQUENCE_DIGITS = 20
const STATUSES = ['observed', 'applied'] as const
type MarkerStatus = (typeof STATUSES)[number]
type Row = Record<string, unknown>

export interface TimelineSteeringMarkerPayload {
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

export interface TimelineSteeringMarkerScope {
  readonly sessionId: string
  readonly turnId?: string
  readonly taskId?: string
}

export interface TimelineSteeringMarkerEvent {
  readonly schemaVersion: typeof AGENT_STREAM_SCHEMA_VERSION
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: null
  readonly taskId: string
  readonly type: typeof STEERING_MARKER_EVENT_TYPE
  readonly actor: 'system'
  readonly sequence: string
  readonly payload: unknown
  readonly createdAt?: string
  readonly kind?: 'delta' | 'snapshot'
  readonly baseRevision?: number
  readonly revision?: number
}

export interface TimelineSteeringMarkerState {
  readonly observed: readonly TimelineSteeringMarkerPayload[]
  readonly applied: readonly TimelineSteeringMarkerPayload[]
  readonly active: readonly TimelineSteeringMarkerPayload[]
  readonly observedCount: number
  readonly appliedCount: number
  readonly activeCount: number
}

export type TimelineSteeringMarkerReduction =
  | { readonly valid: true; readonly state: TimelineSteeringMarkerState }
  | { readonly valid: false; readonly reason: string }

const PAYLOAD_KEYS = ['schemaVersion', 'kind', 'status', 'sessionId', 'turnId', 'taskId', 'stepId', 'inputId', 'idempotencyKey', 'obligationId', 'goalRevision', 'planRevision', 'acceptedSequence'] as const
const EVENT_KEYS = new Set(['schemaVersion', 'id', 'sessionId', 'turnId', 'itemId', 'taskId', 'type', 'actor', 'sequence', 'payload', 'createdAt', 'kind', 'baseRevision', 'revision'])

function plain(value: unknown): value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exact(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function safeText(value: unknown, maxBytes = MAX_ID_BYTES): value is string {
  return typeof value === 'string' && value.length > 0 && byteLength(value) <= maxBytes && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value) && !/\b(?:password|secret|token|api[_-]?key|authorization)\b/i.test(value)
}

function safeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function decimal(value: unknown): string | null {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= MAX_SEQUENCE_DIGITS ? value : null
}

function jsonBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? byteLength(serialized) : null
  } catch {
    return null
  }
}

function before(left: string, right: string): boolean {
  return BigInt(left) < BigInt(right)
}

export function steeringMarkerIdempotencyKey(sessionId: string, turnId: string, inputId: string): string {
  return `steering-marker:${sessionId}:${turnId}:${inputId}`
}

/** Parses only the server-owned marker payload shape; narrative and extra keys fail closed. */
export function parseSteeringMarkerPayload(value: unknown): TimelineSteeringMarkerPayload | null {
  if (!plain(value) || !exact(value, PAYLOAD_KEYS) || value.schemaVersion !== STEERING_MARKER_SCHEMA_VERSION) return null
  if (!STATUSES.includes(value.kind as MarkerStatus) || value.status !== value.kind) return null
  if (!['sessionId', 'turnId', 'taskId', 'stepId', 'inputId'].every(field => safeText(value[field]))) return null
  if (value.obligationId !== null && !safeText(value.obligationId)) return null
  if (!safeRevision(value.goalRevision) || (value.planRevision !== null && !safeRevision(value.planRevision))) return null
  if (!safeText(value.idempotencyKey, MAX_KEY_BYTES) || value.idempotencyKey !== steeringMarkerIdempotencyKey(value.sessionId as string, value.turnId as string, value.inputId as string)) return null
  if (!safeText(value.acceptedSequence, MAX_SEQUENCE_DIGITS) || decimal(value.acceptedSequence) === null) return null
  return {
    schemaVersion: STEERING_MARKER_SCHEMA_VERSION,
    kind: value.kind as MarkerStatus,
    status: value.status as MarkerStatus,
    sessionId: value.sessionId as string,
    turnId: value.turnId as string,
    taskId: value.taskId as string,
    stepId: value.stepId as string,
    inputId: value.inputId as string,
    idempotencyKey: value.idempotencyKey as string,
    obligationId: value.obligationId as string | null,
    goalRevision: value.goalRevision as number,
    planRevision: value.planRevision as number | null,
    acceptedSequence: value.acceptedSequence as string,
  }
}

/** Parses a durable stream envelope after authentication has established the session scope. */
export function parseSteeringMarkerEvent(value: unknown, scope: TimelineSteeringMarkerScope): { readonly id: string; readonly sequence: string; readonly payload: TimelineSteeringMarkerPayload } | null {
  if (!plain(value) || [...Object.keys(value)].some(key => !EVENT_KEYS.has(key)) || value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || value.type !== STEERING_MARKER_EVENT_TYPE || value.actor !== 'system' || value.itemId !== null) return null
  if (value.kind !== undefined || value.baseRevision !== undefined || value.revision !== undefined || value.createdAt !== undefined) return null
  if (!safeText(value.id) || !safeText(value.sessionId) || !safeText(value.turnId) || !safeText(value.taskId)) return null
  if (!safeText(scope.sessionId) || value.sessionId !== scope.sessionId || (scope.turnId !== undefined && value.turnId !== scope.turnId) || (scope.taskId !== undefined && value.taskId !== scope.taskId)) return null
  const sequence = decimal(value.sequence)
  const payload = parseSteeringMarkerPayload(value.payload)
  if (!sequence || !payload || payload.sessionId !== value.sessionId || payload.turnId !== value.turnId || payload.taskId !== value.taskId || before(sequence, payload.acceptedSequence)) return null
  return { id: value.id, sequence, payload }
}

function comparable(payload: TimelineSteeringMarkerPayload): string {
  return JSON.stringify({ schemaVersion: payload.schemaVersion, sessionId: payload.sessionId, turnId: payload.turnId, taskId: payload.taskId, stepId: payload.stepId, inputId: payload.inputId, idempotencyKey: payload.idempotencyKey, obligationId: payload.obligationId, goalRevision: payload.goalRevision, planRevision: payload.planRevision, acceptedSequence: payload.acceptedSequence })
}

function invalid(reason: string): TimelineSteeringMarkerReduction {
  return { valid: false, reason }
}

export function emptyTimelineSteeringMarkerState(): TimelineSteeringMarkerState {
  return { observed: [], applied: [], active: [], observedCount: 0, appliedCount: 0, activeCount: 0 }
}

/** Folds bounded replay/live marker events without mutating prior state or accepting partial corruption. */
export function reduceTimelineSteeringMarkers(events: readonly unknown[], scope: TimelineSteeringMarkerScope): TimelineSteeringMarkerReduction {
  if (!plain(scope) || !safeText(scope.sessionId) || (scope.turnId !== undefined && !safeText(scope.turnId)) || (scope.taskId !== undefined && !safeText(scope.taskId))) return invalid('invalid_scope')
  if (!Array.isArray(events) || events.length > STEERING_MARKER_MAX_EVENTS) return invalid('event_limit')
  const parsed: Array<{ id: string; sequence: string; payload: TimelineSteeringMarkerPayload }> = []
  const eventIds = new Map<string, string>(), eventSequences = new Map<string, string>()
  let bytes = 0
  for (const event of events) {
    const row = parseSteeringMarkerEvent(event, scope)
    if (!row) return invalid('invalid_event')
    const fingerprint = `${row.sequence}:${comparable(row.payload)}:${row.payload.kind}`
    const prior = eventIds.get(row.id)
    if (prior !== undefined) {
      if (prior !== fingerprint) return invalid('event_conflict')
      continue
    }
    const priorId = eventSequences.get(row.sequence)
    if (priorId !== undefined && priorId !== row.id) return invalid('sequence_conflict')
    eventIds.set(row.id, fingerprint)
    eventSequences.set(row.sequence, row.id)
    bytes += jsonBytes(row) ?? STEERING_MARKER_MAX_BYTES
    if (bytes > STEERING_MARKER_MAX_BYTES) return invalid('byte_limit')
    parsed.push(row)
  }

  parsed.sort((left, right) => {
    const sequence = BigInt(left.sequence) - BigInt(right.sequence)
    return sequence === BigInt(0) ? left.id.localeCompare(right.id) : sequence < BigInt(0) ? -1 : 1
  })
  const entries = new Map<string, { observed: TimelineSteeringMarkerPayload; observedSequence: string; applied?: TimelineSteeringMarkerPayload; appliedSequence?: string }>()
  for (const event of parsed) {
    const key = event.payload.idempotencyKey
    const existing = entries.get(key)
    if (!existing) {
      if (event.payload.kind === 'applied') return invalid('orphan_applied')
      entries.set(key, { observed: event.payload, observedSequence: event.sequence })
      continue
    }
    if (comparable(existing.observed) !== comparable(event.payload)) return invalid('marker_conflict')
    if (event.payload.kind === 'observed') {
      if (existing.observedSequence !== event.sequence) return invalid('marker_conflict')
      if (existing.applied) return invalid('observed_after_applied')
      continue
    }
    if (!existing.applied) {
      existing.applied = event.payload
      existing.appliedSequence = event.sequence
    } else if (existing.appliedSequence !== event.sequence || comparable(existing.applied) !== comparable(event.payload)) return invalid('applied_conflict')
  }
  const ordered = [...entries.values()].sort((left, right) => left.observed.idempotencyKey.localeCompare(right.observed.idempotencyKey))
  const observed = ordered.map(entry => entry.observed)
  const applied = ordered.flatMap(entry => entry.applied ? [entry.applied] : [])
  const active = ordered.flatMap(entry => entry.applied ? [] : [entry.observed])
  return { valid: true, state: { observed, applied, active, observedCount: observed.length, appliedCount: applied.length, activeCount: active.length } }
}

export type ParsedTimelineSteeringMarkerEvent = ReturnType<typeof parseSteeringMarkerEvent>
