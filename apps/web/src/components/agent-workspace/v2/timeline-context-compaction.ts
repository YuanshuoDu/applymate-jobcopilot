import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

export const CONTEXT_COMPACTION_EVENT_TYPE = 'context.compaction' as const
export const CONTEXT_COMPACTION_MAX_RECORDS = 8
export const CONTEXT_COMPACTION_QUERY_LIMIT = 16
export const CONTEXT_COMPACTION_MAX_EVENT_BYTES = 16 * 1024
export const CONTEXT_COMPACTION_MAX_PAYLOAD_BYTES = 8 * 1024
export const CONTEXT_COMPACTION_ERROR_CODE = 'context_compaction_failed' as const
const STATUSES = ['unchanged', 'compacted', 'failed'] as const
const EVENT_REQUIRED_KEYS = ['schemaVersion', 'id', 'sessionId', 'turnId', 'itemId', 'taskId', 'type', 'actor', 'sequence', 'payload'] as const
const EVENT_OPTIONAL_KEYS = ['correlationId', 'causationId', 'idempotencyKey', 'createdAt'] as const
const PAYLOAD_REQUIRED_KEYS = ['kind', 'observationId', 'status', 'stepId', 'idempotencyKey', 'beforeInputTokens', 'afterInputTokens', 'beforeBytes', 'afterBytes'] as const
const PAYLOAD_OPTIONAL_KEYS = ['snapshotRef', 'errorCode'] as const
const REDACTED_PAYLOAD_KEYS = ['kind', 'status', 'beforeInputTokens', 'afterInputTokens', 'beforeBytes', 'afterBytes'] as const
const SAFE_SEQUENCE = /^(0|[1-9]\d*)$/
const MAX_SEQUENCE_DIGITS = 39
const MAX_ID_BYTES = 256
const MAX_KEY_BYTES = 512
const MAX_METRIC = Number.MAX_SAFE_INTEGER
const ACTORS = new Set(['orchestrator', 'subagent'] as const)

type Row = Record<string, unknown>
export type TimelineContextCompactionStatus = typeof STATUSES[number]
export interface TimelineContextCompactionPayload {
  readonly kind: 'context_compacted'
  readonly status: TimelineContextCompactionStatus
  readonly beforeInputTokens: number
  readonly afterInputTokens: number
  readonly beforeBytes: number
  readonly afterBytes: number
  readonly observationId?: string
  readonly stepId?: string
  readonly idempotencyKey?: string
  readonly snapshotRef?: string
  readonly errorCode?: typeof CONTEXT_COMPACTION_ERROR_CODE
}
export interface TimelineContextCompactionEnvelope {
  readonly schemaVersion: typeof AGENT_STREAM_SCHEMA_VERSION
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly itemId: null
  readonly taskId: string
  readonly type: typeof CONTEXT_COMPACTION_EVENT_TYPE
  readonly actor: 'orchestrator' | 'subagent'
  readonly sequence: string
  readonly payload: TimelineContextCompactionPayload
  readonly correlationId?: string
  readonly causationId?: string | null
  readonly idempotencyKey?: string | null
  readonly createdAt?: string
}
export interface TimelineContextCompactionRecord {
  readonly eventId: string
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly sequence: string
  readonly createdAt: string | null
  readonly status: TimelineContextCompactionStatus
  readonly beforeInputTokens: number
  readonly afterInputTokens: number
  readonly beforeBytes: number
  readonly afterBytes: number
  readonly savedTokens: number
  readonly savedBytes: number
  readonly tokenReductionRatio: number
}
export interface TimelineContextCompactionState {
  readonly records: readonly TimelineContextCompactionRecord[]
}
export type TimelineContextCompactionProjectionRecord = Omit<TimelineContextCompactionRecord, 'eventId' | 'sessionId' | 'turnId' | 'taskId'> & { readonly scopeOrdinal: number }
export interface TimelineContextCompactionProjection { readonly records: readonly TimelineContextCompactionProjectionRecord[] }
export interface ContextCompactionQueryRow {
  readonly id: unknown
  readonly sessionId: unknown
  readonly turnId: unknown
  readonly itemId: unknown
  readonly taskId: unknown
  readonly sequence: unknown
  readonly type: unknown
  readonly actor: unknown
  readonly correlationId?: unknown
  readonly causationId?: unknown
  readonly idempotencyKey?: unknown
  readonly createdAt?: unknown
  readonly payload: unknown
}

function plain(value: unknown): value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function exact(value: Row, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key))
}
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength }
function safeText(value: unknown, maximum = MAX_ID_BYTES): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && bytes(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
}
function safeMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_METRIC
}
function jsonBytes(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? null : bytes(encoded)
  } catch { return null }
}
function safeTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
}
type MetricTuple = readonly [beforeInputTokens: number, afterInputTokens: number, beforeBytes: number, afterBytes: number]
function parseMetrics(value: Row, status: TimelineContextCompactionStatus): MetricTuple | null {
  const keys = ['beforeInputTokens', 'afterInputTokens', 'beforeBytes', 'afterBytes']
  if (!keys.every(key => safeMetric(value[key]))) return null
  const metrics = [value.beforeInputTokens, value.afterInputTokens, value.beforeBytes, value.afterBytes] as MetricTuple
  const [beforeInputTokens, afterInputTokens, beforeBytes, afterBytes] = metrics
  if ((status === 'unchanged' || status === 'failed') && (beforeInputTokens !== afterInputTokens || beforeBytes !== afterBytes)) return null
  if (status === 'compacted' && (afterInputTokens >= beforeInputTokens || afterBytes > beforeBytes)) return null
  return metrics
}
function parseRawPayload(value: unknown, envelope: Row): TimelineContextCompactionPayload | null {
  if (!plain(value)) return null
  if (!exact(value, PAYLOAD_REQUIRED_KEYS, PAYLOAD_OPTIONAL_KEYS) || value.kind !== 'context_compacted' || !STATUSES.includes(value.status as TimelineContextCompactionStatus)) return null
  if (!safeText(value.observationId) || !safeText(value.stepId) || !safeText(value.idempotencyKey, MAX_KEY_BYTES) || value.observationId !== `context-compacted:${value.stepId}` || value.idempotencyKey !== `context-compaction:${value.stepId}`) return null
  const metrics = parseMetrics(value, value.status as TimelineContextCompactionStatus)
  if (!metrics) return null
  if (envelope.correlationId !== undefined && envelope.correlationId !== value.stepId) return null
  const hasSnapshotRef = Object.prototype.hasOwnProperty.call(value, 'snapshotRef')
  const hasErrorCode = Object.prototype.hasOwnProperty.call(value, 'errorCode')
  if (value.status === 'compacted' && (!hasSnapshotRef || !safeText(value.snapshotRef) || hasErrorCode)) return null
  if (value.status !== 'compacted' && hasSnapshotRef) return null
  if (value.status === 'failed' && (!hasErrorCode || value.errorCode !== CONTEXT_COMPACTION_ERROR_CODE)) return null
  if (value.status !== 'failed' && hasErrorCode) return null
  const [beforeInputTokens, afterInputTokens, beforeBytes, afterBytes] = metrics
  return {
    kind: 'context_compacted', status: value.status as TimelineContextCompactionStatus,
    observationId: value.observationId as string, stepId: value.stepId as string, idempotencyKey: value.idempotencyKey as string,
    beforeInputTokens, afterInputTokens, beforeBytes, afterBytes,
    ...(hasSnapshotRef ? { snapshotRef: value.snapshotRef as string } : {}),
    ...(hasErrorCode ? { errorCode: value.errorCode as typeof CONTEXT_COMPACTION_ERROR_CODE } : {}),
  }
}

function parseRedactedPayload(value: unknown, _envelope: Row): TimelineContextCompactionPayload | null {
  if (!plain(value) || !exact(value, REDACTED_PAYLOAD_KEYS) || value.kind !== 'context_compacted' || !STATUSES.includes(value.status as TimelineContextCompactionStatus)) return null
  const metrics = parseMetrics(value, value.status as TimelineContextCompactionStatus)
  if (!metrics) return null
  const [beforeInputTokens, afterInputTokens, beforeBytes, afterBytes] = metrics
  return { kind: 'context_compacted', status: value.status as TimelineContextCompactionStatus, beforeInputTokens, afterInputTokens, beforeBytes, afterBytes }
}
type ContextCompactionPayloadParser = (value: unknown, envelope: Row) => TimelineContextCompactionPayload | null

export interface TimelineContextCompactionParseOptions {
  readonly allowRedacted?: boolean
}
function parseEnvelope(value: unknown, expectedSessionId: string, parsePayload: ContextCompactionPayloadParser): TimelineContextCompactionEnvelope | null {
  try {
    if (!plain(value) || !safeText(expectedSessionId) || !exact(value, EVENT_REQUIRED_KEYS, EVENT_OPTIONAL_KEYS) || value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || value.type !== CONTEXT_COMPACTION_EVENT_TYPE || !safeText(value.id) || value.sessionId !== expectedSessionId || !safeText(value.sessionId) || !safeText(value.turnId) || value.itemId !== null || !safeText(value.taskId) || !ACTORS.has(value.actor as 'orchestrator' | 'subagent') || typeof value.sequence !== 'string' || !SAFE_SEQUENCE.test(value.sequence) || value.sequence.length > MAX_SEQUENCE_DIGITS) return null
    if (value.correlationId !== undefined && !safeText(value.correlationId)) return null
    if (value.causationId !== undefined && value.causationId !== null && !safeText(value.causationId)) return null
    if (value.idempotencyKey !== undefined && !safeText(value.idempotencyKey, MAX_KEY_BYTES)) return null
    if (value.createdAt !== undefined && !safeTimestamp(value.createdAt)) return null
    const payload = parsePayload(value.payload, value)
    const payloadSize = jsonBytes(value.payload)
    const eventSize = jsonBytes(value)
    if (!payload || payloadSize === null || payloadSize > CONTEXT_COMPACTION_MAX_PAYLOAD_BYTES || eventSize === null || eventSize > CONTEXT_COMPACTION_MAX_EVENT_BYTES) return null
    const ownerPrefix = value.actor === 'subagent' ? `task:${value.taskId}` : `turn:${value.turnId}`
    if (value.idempotencyKey !== undefined && value.idempotencyKey !== `${ownerPrefix}:event:${payload.idempotencyKey}`) return null
    return {
      schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: value.id as string, sessionId: expectedSessionId, turnId: value.turnId as string,
      itemId: null, taskId: value.taskId as string, type: CONTEXT_COMPACTION_EVENT_TYPE, actor: value.actor as 'orchestrator' | 'subagent', sequence: value.sequence as string,
      payload, ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
      ...(value.causationId === undefined ? {} : { causationId: value.causationId as string | null }),
      ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey as string | null }),
      ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt as string }),
    }
  } catch { return null }
}

/** Strictly parses a canonical context.compaction event after session authentication. */
export function parseTimelineContextCompactionEvent(
  value: unknown,
  expectedSessionId: string,
  options: TimelineContextCompactionParseOptions = {},
): TimelineContextCompactionEnvelope | null {
  return parseEnvelope(value, expectedSessionId, options.allowRedacted === true ? parseRedactedPayload : parseRawPayload)
}
/** Parses only the browser-safe context.compaction envelope. */
export function parseRedactedTimelineContextCompactionEvent(value: unknown, expectedSessionId: string): TimelineContextCompactionEnvelope | null {
  return parseTimelineContextCompactionEvent(value, expectedSessionId, { allowRedacted: true })
}
export const parseContextCompactionEvent = parseTimelineContextCompactionEvent
/** Projects a validated database row into a browser-safe envelope with sensitive payload fields removed. */
export function projectContextCompactionRow(row: ContextCompactionQueryRow, expectedSessionId: string): TimelineContextCompactionEnvelope | null {
  const sequence = typeof row.sequence === 'bigint' || typeof row.sequence === 'number' ? String(row.sequence) : typeof row.sequence === 'string' ? row.sequence : ''
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : typeof row.createdAt === 'string' ? row.createdAt : undefined
  const parsed = parseTimelineContextCompactionEvent({
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId,
    type: row.type, actor: row.actor, sequence, payload: row.payload,
    ...(row.correlationId === undefined ? {} : { correlationId: row.correlationId }),
    ...(row.causationId === undefined ? {} : { causationId: row.causationId }),
    ...(row.idempotencyKey === undefined ? {} : { idempotencyKey: row.idempotencyKey }),
    ...(createdAt === undefined ? {} : { createdAt }),
  }, expectedSessionId)
  if (!parsed) return null
  const safe = {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: parsed.id, sessionId: parsed.sessionId, turnId: parsed.turnId, itemId: null, taskId: parsed.taskId,
    type: parsed.type, actor: parsed.actor, sequence: parsed.sequence,
    payload: { kind: 'context_compacted', status: parsed.payload.status, beforeInputTokens: parsed.payload.beforeInputTokens, afterInputTokens: parsed.payload.afterInputTokens, beforeBytes: parsed.payload.beforeBytes, afterBytes: parsed.payload.afterBytes },
    ...(parsed.createdAt === undefined ? {} : { createdAt: parsed.createdAt }),
  }
  return parseTimelineContextCompactionEvent(safe, expectedSessionId, { allowRedacted: true })
}
export function createTimelineContextCompactionState(): TimelineContextCompactionState { return { records: [] } }
export function contextCompactionRecord(event: TimelineContextCompactionEnvelope): TimelineContextCompactionRecord {
  const { beforeInputTokens, afterInputTokens, beforeBytes, afterBytes } = event.payload
  const savedTokens = beforeInputTokens - afterInputTokens
  const savedBytes = beforeBytes - afterBytes
  return {
    eventId: event.id, sessionId: event.sessionId, turnId: event.turnId, taskId: event.taskId, sequence: event.sequence, createdAt: event.createdAt ?? null,
    status: event.payload.status, beforeInputTokens, afterInputTokens, beforeBytes, afterBytes,
    savedTokens, savedBytes, tokenReductionRatio: beforeInputTokens > 0 ? savedTokens / beforeInputTokens : 0,
  }
}
/** Folds one validated event into one latest record per turn/task scope. */
export function reduceTimelineContextCompaction(state: TimelineContextCompactionState, event: TimelineContextCompactionEnvelope): TimelineContextCompactionState {
  const scope = `${event.turnId}\u0000${event.taskId}`
  const existing = state.records.find(record => `${record.turnId}\u0000${record.taskId}` === scope)
  if (existing && (existing.eventId === event.id || compareSequence(event.sequence, existing.sequence) <= 0)) return state
  const records = [...state.records.filter(record => `${record.turnId}\u0000${record.taskId}` !== scope), contextCompactionRecord(event)]
    .sort((left, right) => compareSequence(right.sequence, left.sequence) || right.eventId.localeCompare(left.eventId))
    .slice(0, CONTEXT_COMPACTION_MAX_RECORDS)
  return { records }
}
/** Exposes only browser-safe metrics; scope and event identities stay reducer-owned. */
export function selectTimelineContextCompactionProjection(state: TimelineContextCompactionState): TimelineContextCompactionProjection {
  return { records: state.records.map((record, index) => { const { eventId: _eventId, sessionId: _sessionId, turnId: _turnId, taskId: _taskId, ...safe } = record; return { scopeOrdinal: index + 1, ...safe } }) }
}
function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left), rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}
