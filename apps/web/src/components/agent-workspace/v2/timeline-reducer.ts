import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import { buildIndexes, compareItems, integer, isAfter, isRecord, mergeContent, numberOrUndefined, sequence, stringOrNull, timestamp } from './timeline-reducer-utils'

export type TimelineConnection = 'idle' | 'connected' | 'reconnecting'
export type TimelineItemSource = 'replay' | 'durable' | 'transient' | 'unknown'

export interface TimelineItem {
  schemaVersion: string
  id: string
  sessionId: string
  turnId: string
  stepId: string | null
  taskId: string | null
  type: string
  status: string
  phase: string | null
  revision: number
  content: unknown
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  source: TimelineItemSource
  sequence: string | null
}

export interface TimelineEvent {
  schemaVersion: string
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  type: string
  actor: string
  sequence: string | null
  payload: unknown
  createdAt?: string
  kind?: 'delta' | 'snapshot'
  baseRevision?: number
  revision?: number
}

export interface TimelineState {
  sessionId: string
  itemIds: string[]
  itemsById: Record<string, TimelineItem>
  itemIdsByTurnId: Record<string, string[]>
  itemIdsByTaskId: Record<string, string[]>
  processedEventIds: Record<string, true>
  lastSequence: string | null
  connection: TimelineConnection
  snapshotRequired: boolean
}

export type TimelineAction =
  | { type: 'hydrate'; items: unknown[]; tail?: unknown[]; deltas?: unknown[] }
  | { type: 'replay'; items: unknown[] }
  | { type: 'event'; event: unknown }
  | { type: 'delta'; delta: unknown }
  | { type: 'legacy'; event: unknown }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'snapshot-required' }

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted'])
const KNOWN_EVENT_TYPES = new Set([
  'turn.started', 'turn.wakeup', 'turn.resumed', 'turn.completed', 'turn.failed',
  'step.started', 'step.completed', 'item.started', 'item.delta', 'item.completed', 'item.failed',
  'input.accepted', 'input.consumed', 'tool_call.started', 'tool_call.completed', 'tool_call.failed',
  'policy.decision', 'approval.requested', 'approval.resolved', 'approval.consumed', 'approval.expired',
  'question.answered', 'question.cancelled', 'external_action.reserved', 'stream.overflow',
])

export function createTimelineState(sessionId: string): TimelineState {
  return {
    sessionId, itemIds: [], itemsById: {}, itemIdsByTurnId: {}, itemIdsByTaskId: {},
    processedEventIds: {}, lastSequence: null, connection: 'idle', snapshotRequired: false,
  }
}

export function selectTimelineItems(state: TimelineState): TimelineItem[] {
  return state.itemIds.map((id) => state.itemsById[id]).filter((item): item is TimelineItem => Boolean(item))
}

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case 'hydrate': {
      let next = reduceItems(state, action.items, 'replay')
      for (const event of action.tail ?? []) next = reduceEvent(next, event)
      for (const delta of action.deltas ?? []) next = reduceDelta(next, delta)
      return { ...next, snapshotRequired: false }
    }
    case 'replay': return reduceItems(state, action.items, 'replay')
    case 'event': return reduceEvent(state, action.event)
    case 'delta': return reduceDelta(state, action.delta)
    case 'legacy': return reduceLegacy(state, action.event)
    case 'connected': return { ...state, connection: 'connected' }
    case 'disconnected': return { ...state, connection: 'reconnecting' }
    case 'snapshot-required': return { ...state, snapshotRequired: true, connection: 'reconnecting' }
  }
}

export function normalizeTimelineItem(value: unknown, source: TimelineItemSource = 'replay'): TimelineItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sessionId !== 'string' ||
    typeof value.turnId !== 'string' || typeof value.type !== 'string' ||
    value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION) return null
  const createdAt = timestamp(value.createdAt) ?? new Date(0).toISOString()
  return {
    schemaVersion: typeof value.schemaVersion === 'string' ? value.schemaVersion : AGENT_STREAM_SCHEMA_VERSION,
    id: value.id, sessionId: value.sessionId, turnId: value.turnId,
    stepId: stringOrNull(value.stepId), taskId: stringOrNull(value.taskId), type: value.type,
    status: typeof value.status === 'string' ? value.status : 'started',
    phase: stringOrNull(value.phase), revision: integer(value.revision), content: value.content ?? null,
    startedAt: timestamp(value.startedAt), completedAt: timestamp(value.completedAt),
    createdAt, updatedAt: timestamp(value.updatedAt) ?? createdAt, source, sequence: sequence(value.sequence),
  }
}

export function normalizeTimelineEvent(value: unknown): TimelineEvent | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sessionId !== 'string' ||
    typeof value.turnId !== 'string' || typeof value.type !== 'string' ||
    value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION) return null
  const rawKind = value.kind
  if (rawKind !== undefined && rawKind !== 'delta' && rawKind !== 'snapshot') return null
  const kind = rawKind === 'delta' || rawKind === 'snapshot' ? rawKind : undefined
  const rawSequence = value.sequence
  if (rawSequence !== null && rawSequence !== undefined && sequence(rawSequence) === null) return null
  return {
    schemaVersion: typeof value.schemaVersion === 'string' ? value.schemaVersion : AGENT_STREAM_SCHEMA_VERSION,
    id: value.id, sessionId: value.sessionId, turnId: value.turnId,
    itemId: stringOrNull(value.itemId), taskId: stringOrNull(value.taskId), type: value.type,
    actor: typeof value.actor === 'string' ? value.actor : 'system', sequence: sequence(rawSequence),
    payload: value.payload ?? null, createdAt: timestamp(value.createdAt) ?? undefined, kind,
    baseRevision: numberOrUndefined(value.baseRevision), revision: numberOrUndefined(value.revision),
  }
}

function reduceItems(state: TimelineState, values: unknown[], source: TimelineItemSource): TimelineState {
  let next = state
  for (const value of values) {
    const item = normalizeTimelineItem(value, source)
    if (item?.sessionId === state.sessionId) next = upsertItem(next, item, source)
  }
  return next
}

function reduceEvent(state: TimelineState, value: unknown): TimelineState {
  const event = normalizeTimelineEvent(value)
  if (!event || event.sessionId !== state.sessionId || state.processedEventIds[event.id]) return state
  if (event.sequence !== null && !isAfter(event.sequence, state.lastSequence)) return state
  const processedEventIds: Record<string, true> = { ...state.processedEventIds, [event.id]: true }
  const next: TimelineState = {
    ...state,
    processedEventIds,
    lastSequence: event.sequence && isAfter(event.sequence, state.lastSequence) ? event.sequence : state.lastSequence,
  }
  if (event.type === 'stream.overflow') return { ...next, snapshotRequired: true, connection: 'reconnecting' }
  if (event.type === 'item.delta') {
    const existingRevision = state.itemsById[event.itemId ?? '']?.revision ?? 0
    return reduceDelta(next, { ...event, kind: 'delta', revision: event.revision ?? existingRevision + 1 })
  }
  if (!event.itemId) return KNOWN_EVENT_TYPES.has(event.type) ? next : addUnknownEvent(next, event)
  const existing = state.itemsById[event.itemId]
  const status = event.type === 'item.completed' ? 'completed' : event.type === 'item.failed' ? 'failed' : existing?.status ?? 'started'
  if (existing && TERMINAL_STATUSES.has(existing.status) && status !== 'completed') return next
  const item = itemFromEvent(event, status, existing)
  return item ? upsertItem(next, item, item.source === 'unknown' ? 'unknown' : 'durable') : next
}

function reduceDelta(state: TimelineState, value: unknown): TimelineState {
  const delta = normalizeTimelineEvent(value)
  if (!delta || delta.sessionId !== state.sessionId || !delta.itemId || state.processedEventIds[delta.id]) return state
  const processedEventIds: Record<string, true> = { ...state.processedEventIds, [delta.id]: true }
  state = { ...state, processedEventIds }
  const payload = isRecord(delta.payload) ? delta.payload : {}
  const revision = delta.revision ?? numberOrUndefined(payload.revision)
  if (revision === undefined) return state
  const existing = state.itemsById[delta.itemId]
  if (existing && (TERMINAL_STATUSES.has(existing.status) || revision <= existing.revision)) return state
  if (delta.kind === 'delta' && delta.baseRevision !== undefined && delta.baseRevision > (existing?.revision ?? 0)) {
    return { ...state, snapshotRequired: true, connection: 'reconnecting' }
  }
  const item = itemFromEvent(delta, 'streaming', existing, revision)
  if (!item) return state
  const next = upsertItem(state, { ...item, revision, source: 'transient' }, 'transient', delta.kind === 'snapshot')
  return delta.kind === 'snapshot' ? { ...next, snapshotRequired: false } : next
}

function reduceLegacy(state: TimelineState, value: unknown): TimelineState {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string' ||
    typeof value.speaker !== 'string' || typeof value.body !== 'string' || typeof value.createdAt !== 'string') return state
  const item: TimelineItem = {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: `legacy:${value.id}`, sessionId: state.sessionId,
    turnId: typeof value.turnId === 'string' ? value.turnId : 'legacy', stepId: null,
    taskId: stringOrNull(value.taskId), type: value.type, status: 'completed', phase: 'commentary', revision: 0,
    content: { speaker: value.speaker, title: stringOrNull(value.title), body: value.body, data: value.data ?? null },
    startedAt: value.createdAt, completedAt: value.createdAt, createdAt: value.createdAt, updatedAt: value.createdAt,
    source: 'replay', sequence: null,
  }
  return upsertItem(state, item, 'replay')
}

function itemFromEvent(event: TimelineEvent, status: string, existing?: TimelineItem, revision?: number): TimelineItem | null {
  const payload = isRecord(event.payload) ? event.payload : {}
  const candidate = normalizeTimelineItem(payload.item, event.kind ? 'transient' : 'durable') ??
    (payload.id === event.itemId ? normalizeTimelineItem(payload, event.kind ? 'transient' : 'durable') : null)
  if (candidate) return { ...candidate, status, revision: revision ?? candidate.revision, sequence: event.sequence ?? candidate.sequence }
  if (!existing && event.itemId) return {
    schemaVersion: event.schemaVersion, id: event.itemId, sessionId: event.sessionId, turnId: event.turnId,
    stepId: null, taskId: event.taskId, type: 'unknown', status, phase: null, revision: revision ?? 0,
    content: { eventType: event.type, payload: event.payload, opaque: true }, startedAt: event.createdAt ?? null,
    completedAt: status === 'completed' ? event.createdAt ?? null : null,
    createdAt: event.createdAt ?? new Date(0).toISOString(), updatedAt: event.createdAt ?? new Date(0).toISOString(),
    source: event.kind ? 'transient' : 'unknown', sequence: event.sequence,
  }
  if (!existing) return null
  const content = event.type === 'item.completed' || event.type === 'item.failed' || event.kind === 'snapshot'
    ? payload.content ?? payload
    : mergeContent(existing.content, payload.content ?? payload)
  return { ...existing, taskId: event.taskId ?? existing.taskId, status, revision: revision ?? existing.revision,
    content, completedAt: status === 'completed' ? event.createdAt ?? existing.completedAt : existing.completedAt,
    updatedAt: event.createdAt ?? existing.updatedAt, sequence: event.sequence ?? existing.sequence }
}

function addUnknownEvent(state: TimelineState, event: TimelineEvent): TimelineState {
  const itemId = `unknown:${event.id}`
  return upsertItem(state, {
    schemaVersion: event.schemaVersion, id: itemId, sessionId: event.sessionId, turnId: event.turnId,
    stepId: null, taskId: event.taskId, type: 'unknown', status: 'completed', phase: 'commentary', revision: 0,
    content: { eventType: event.type, payload: event.payload, opaque: true }, startedAt: event.createdAt ?? null,
    completedAt: event.createdAt ?? null, createdAt: event.createdAt ?? new Date(0).toISOString(),
    updatedAt: event.createdAt ?? new Date(0).toISOString(), source: 'unknown', sequence: event.sequence,
  }, 'unknown')
}

function upsertItem(state: TimelineState, item: TimelineItem, source: TimelineItemSource, replaceContent = false): TimelineState {
  const existing = state.itemsById[item.id]
  if (existing && source === 'transient' && (TERMINAL_STATUSES.has(existing.status) || item.revision <= existing.revision)) return state
  if (existing && source === 'durable' && existing.sequence && item.sequence && !isAfter(item.sequence, existing.sequence) && item.status !== 'completed') return state
  const nextItem = source === 'transient' && existing
    ? { ...existing, ...item, content: replaceContent ? item.content : mergeContent(existing.content, item.content), source }
    : { ...existing, ...item, source }
  const itemsById = { ...state.itemsById, [item.id]: nextItem }
  const itemIds = Object.values(itemsById).sort(compareItems).map((entry) => entry.id)
  return { ...state, itemsById, itemIds, ...buildIndexes(itemsById) }
}
