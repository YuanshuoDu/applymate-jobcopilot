/** CANONICAL Phase 9 timeline state root — do not duplicate. See #459. */

import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import { isApprovalLedgerEventType, parseApprovalLedgerEvent } from './approval-ledger-parser'
import { createApprovalLedgerState, reduceApprovalLedger, type ApprovalLedgerState } from './approval-ledger-view'
import { createCognitiveAgendaState, reduceCognitiveAgenda, type TimelineCognitiveAgendaState } from './timeline-cognitive-agenda'
import { CONTEXT_COMPACTION_EVENT_TYPE, createTimelineContextCompactionState, parseRedactedTimelineContextCompactionEvent, parseTimelineContextCompactionEvent, reduceTimelineContextCompaction, type TimelineContextCompactionState } from './timeline-context-compaction'
import { isPlanLedgerEventType, parsePlanLedgerEvent } from './plan-ledger-parser'
import { createPlanLedgerState, reducePlanLedger, type PlanLedgerState } from './plan-ledger-view'
import { parseQuestionInputItem, parseQuestionTerminalEvent } from './question-input-parser'
import { emptyTimelineSteeringMarkerState, reduceTimelineSteeringMarkers, STEERING_MARKER_EVENT_TYPE, STEERING_MARKER_MAX_EVENTS, type TimelineSteeringMarkerEvent, type TimelineSteeringMarkerState } from './timeline-steering-markers'
import { createTimelineSessionControlState, isSessionControlEventCandidate, parseTimelineSessionControl, reduceTimelineSessionControl, type TimelineSessionControlEvent, type TimelineSessionControlState } from './timeline-session-control'
import { appendFallbackEvent, appendTimelineEvent, buildIndexes, compareItems, integer, isAfter, isRecord, itemFromTimelineEvent, mergeContent, numberOrUndefined, sequence, stringOrNull, timestamp } from './timeline-reducer-utils'

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
  events: TimelineEvent[]
  byId: Map<string, TimelineEvent>
  byTurnId: Map<string, TimelineEvent[]>
  byToolCallId: Map<string, TimelineEvent[]>
  lastEventId: string | null
  transientItems: Map<string, TimelineItem>
  fallbackItems: TimelineEvent[]
  itemIds: string[]
  itemsById: Record<string, TimelineItem>
  itemIdsByTurnId: Record<string, string[]>
  itemIdsByTaskId: Record<string, string[]>
  processedEventIds: Record<string, true>
  lastSequence: string | null
  sessionControl: TimelineSessionControlState
  lifecycleRevision: number
  cognitiveAgenda: TimelineCognitiveAgendaState
  planLedger: PlanLedgerState
  approvalLedger: ApprovalLedgerState
  contextCompaction: TimelineContextCompactionState
  steeringMarkers: TimelineSteeringMarkerState
  steeringMarkerEvents: readonly TimelineSteeringMarkerEvent[]
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
  'plan.revision', 'plan.command', 'plan.observation',
  'question.answered', 'question.cancelled', 'external_action.reserved', 'stream.overflow', 'cognitive.agenda', CONTEXT_COMPACTION_EVENT_TYPE, STEERING_MARKER_EVENT_TYPE,
])

// Status-only events drive supervisor metadata refreshes. Item deltas are
// intentionally excluded so streamed text does not refetch turns and tasks.
const LIFECYCLE_EVENT_TYPES = new Set([
  'turn.started', 'turn.wakeup', 'turn.resumed', 'turn.completed', 'turn.failed',
  'step.started', 'step.completed', 'item.started', 'item.completed', 'item.failed',
  'tool_call.started', 'tool_call.completed', 'tool_call.failed',
  'approval.requested', 'approval.resolved', 'approval.consumed', 'approval.expired',
  'question.answered', 'question.cancelled', 'external_action.reserved',
])

export function createTimelineState(sessionId: string): TimelineState {
  return {
    sessionId, events: [], byId: new Map(), byTurnId: new Map(), byToolCallId: new Map(), lastEventId: null,
    transientItems: new Map(), fallbackItems: [],
    itemIds: [], itemsById: {}, itemIdsByTurnId: {}, itemIdsByTaskId: {},
    processedEventIds: {}, lastSequence: null, sessionControl: createTimelineSessionControlState(), lifecycleRevision: 0, cognitiveAgenda: createCognitiveAgendaState(sessionId), planLedger: createPlanLedgerState(sessionId), approvalLedger: createApprovalLedgerState(sessionId), contextCompaction: createTimelineContextCompactionState(), steeringMarkers: emptyTimelineSteeringMarkerState(), steeringMarkerEvents: [], connection: 'idle', snapshotRequired: false,
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
  if (value.type === STEERING_MARKER_EVENT_TYPE && (value.actor !== 'system' || value.itemId !== null)) return null
  if (value.type === STEERING_MARKER_EVENT_TYPE && Object.keys(value).some(key => !['schemaVersion', 'id', 'sessionId', 'turnId', 'itemId', 'taskId', 'type', 'actor', 'correlationId', 'causationId', 'idempotencyKey', 'sequence', 'payload', 'createdAt', 'kind', 'baseRevision', 'revision'].includes(key))) return null
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
    if (item?.sessionId !== state.sessionId) continue
    if (item.type === 'question' && !parseQuestionInputItem(value, state.sessionId)) continue
    next = upsertItem(next, questionTerminalItem(next, item), source)
  }
  return next
}

function reduceEvent(state: TimelineState, value: unknown): TimelineState {
  if (isRecord(value) && value.type === CONTEXT_COMPACTION_EVENT_TYPE) return reduceContextCompactionEvent(state, value)
  const questionTerminalCandidate = isRecord(value) && (value.type === 'question.answered' || value.type === 'question.cancelled')
  if (questionTerminalCandidate) return reduceQuestionTerminalEvent(state, value)
  const approvalCandidate = isRecord(value) && isApprovalLedgerEventType(value.type)
  if (approvalCandidate) return reduceApprovalEvent(state, value)
  const planCandidate = isRecord(value) && isPlanLedgerEventType(value.type)
  if (planCandidate) return reducePlanEvent(state, value)
  const sessionControl = parseTimelineSessionControl(value, state.sessionId)
  if (sessionControl) return reduceSessionControlEvent(state, sessionControl)
  if (isSessionControlEventCandidate(value)) return state
  const event = normalizeTimelineEvent(value)
  if (!event || event.sessionId !== state.sessionId || state.processedEventIds[event.id]) return state
  const markerState = event.type === STEERING_MARKER_EVENT_TYPE ? reduceMarkerEvent(state, event) : null
  if (event.type === STEERING_MARKER_EVENT_TYPE && !markerState) return state
  if (event.sequence !== null && !isAfter(event.sequence, state.lastSequence)) return state
  const processedEventIds: Record<string, true> = { ...state.processedEventIds, [event.id]: true }
  let next: TimelineState = {
    ...state,
    processedEventIds,
    lastSequence: event.sequence && isAfter(event.sequence, state.lastSequence) ? event.sequence : state.lastSequence,
  }
  next = {
    ...next,
    ...appendTimelineEvent(next.events, event),
    lastEventId: event.id,
    lifecycleRevision: LIFECYCLE_EVENT_TYPES.has(event.type) ? state.lifecycleRevision + 1 : state.lifecycleRevision,
  }
  if (markerState) {
    return { ...next, steeringMarkers: markerState.state, steeringMarkerEvents: markerState.events }
  }
  if (event.type === 'cognitive.agenda') next = { ...next, cognitiveAgenda: reduceCognitiveAgenda(next.cognitiveAgenda, event) }
  if (event.type === 'stream.overflow') return { ...next, snapshotRequired: true, connection: 'reconnecting' }
  if (event.type === 'item.delta') {
    const existingRevision = state.itemsById[event.itemId ?? '']?.revision ?? 0
    return reduceDelta(next, { ...event, kind: 'delta', revision: event.revision ?? existingRevision + 1 }, event.id)
  }
  if (event.type === 'item.started' && isRecord(event.payload) && event.payload.waitKind === 'question' && !isRecord(event.payload.item)) return next
  if (!event.itemId) return KNOWN_EVENT_TYPES.has(event.type) ? next : addUnknownEvent(next, event)
  const existing = state.itemsById[event.itemId]
  const status = event.type === 'item.completed' ? 'completed' : event.type === 'item.failed' ? 'failed' : existing?.status ?? 'started'
  if (existing && TERMINAL_STATUSES.has(existing.status) && status !== 'completed') return next
  if (!KNOWN_EVENT_TYPES.has(event.type)) next = { ...next, fallbackItems: appendFallbackEvent(next.fallbackItems, event) }
  const item = itemFromTimelineEvent(event, status, existing, undefined, normalizeTimelineItem)
  if (item?.type === 'question' && isRecord(event.payload) && !parseQuestionInputItem(event.payload.item ?? event.payload, state.sessionId)) return next
  return item ? upsertItem(next, item, item.source === 'unknown' ? 'unknown' : 'durable') : next
}

function reduceContextCompactionEvent(state: TimelineState, value: Record<string, unknown>): TimelineState {
  const parsed = parseTimelineContextCompactionEvent(value, state.sessionId) ??
    parseRedactedTimelineContextCompactionEvent(value, state.sessionId)
  if (!parsed || state.processedEventIds[parsed.id]) return state
  const contextCompaction = reduceTimelineContextCompaction(state.contextCompaction, parsed)
  const event = normalizeTimelineEvent(value)
  if (!event || event.sessionId !== state.sessionId) return state
  return {
    ...state,
    processedEventIds: { ...state.processedEventIds, [event.id]: true },
    lastSequence: event.sequence && isAfter(event.sequence, state.lastSequence) ? event.sequence : state.lastSequence,
    ...appendTimelineEvent(state.events, event),
    lastEventId: event.id,
    contextCompaction,
  }
}

function reduceQuestionTerminalEvent(state: TimelineState, value: Record<string, unknown>): TimelineState {
  const terminal = parseQuestionTerminalEvent(value, state.sessionId)
  if (!terminal || state.processedEventIds[terminal.id] || !isAfter(terminal.sequence, state.lastSequence)) return state
  const event = normalizeTimelineEvent(value)
  if (!event || event.sessionId !== state.sessionId) return state
  const existing = state.itemsById[terminal.itemId]
  if (existing && (existing.type !== 'question' || existing.turnId !== terminal.turnId || existing.taskId !== terminal.taskId || !isRecord(existing.content) || existing.content.questionId !== terminal.questionId)) return state
  if (existing && TERMINAL_STATUSES.has(existing.status) && existing.status !== terminal.status) return state
  const processedEventIds: Record<string, true> = { ...state.processedEventIds, [event.id]: true }
  let next: TimelineState = {
    ...state,
    processedEventIds,
    lastSequence: terminal.sequence,
    ...appendTimelineEvent(state.events, event),
    lastEventId: event.id,
    lifecycleRevision: LIFECYCLE_EVENT_TYPES.has(event.type) ? state.lifecycleRevision + 1 : state.lifecycleRevision,
  }
  if (!existing) return next
  const content = isRecord(existing.content)
    ? { ...existing.content, pending: false, answerAvailable: terminal.status === 'completed', ...(terminal.status === 'interrupted' ? { cancelled: true, cancellationReason: 'interrupt' } : {}) }
    : existing.content
  return upsertItem(next, { ...existing, status: terminal.status, content, completedAt: event.createdAt ?? existing.completedAt, updatedAt: event.createdAt ?? existing.updatedAt, sequence: terminal.sequence }, 'durable')
}

function reduceApprovalEvent(state: TimelineState, value: Record<string, unknown>): TimelineState {
  const parsed = parseApprovalLedgerEvent(value, state.sessionId)
  if (!parsed || state.processedEventIds[parsed.id] || !isAfter(parsed.sequence, state.lastSequence)) return state
  const event = normalizeTimelineEvent(value)
  if (!event || event.sessionId !== state.sessionId) return state
  const approvalLedger = reduceApprovalLedger(state.approvalLedger, value)
  if (approvalLedger === state.approvalLedger) return state
  const processedEventIds: Record<string, true> = { ...state.processedEventIds, [event.id]: true }
  return {
    ...state,
    processedEventIds,
    lastSequence: event.sequence && isAfter(event.sequence, state.lastSequence) ? event.sequence : state.lastSequence,
    ...appendTimelineEvent(state.events, event),
    lastEventId: event.id,
    lifecycleRevision: LIFECYCLE_EVENT_TYPES.has(event.type) ? state.lifecycleRevision + 1 : state.lifecycleRevision,
    approvalLedger,
  }
}

function reducePlanEvent(state: TimelineState, value: Record<string, unknown>): TimelineState {
  const parsed = parsePlanLedgerEvent(value, state.sessionId)
  if (!parsed || state.processedEventIds[parsed.id] || !isAfter(parsed.sequence, state.lastSequence)) return state
  const event = normalizeTimelineEvent(value)
  if (!event || event.sessionId !== state.sessionId) return state
  const planLedger = reducePlanLedger(state.planLedger, value)
  if (planLedger === state.planLedger) return state
  const processedEventIds: Record<string, true> = { ...state.processedEventIds, [event.id]: true }
  return {
    ...state,
    processedEventIds,
    lastSequence: event.sequence && isAfter(event.sequence, state.lastSequence) ? event.sequence : state.lastSequence,
    ...appendTimelineEvent(state.events, event),
    lastEventId: event.id,
    planLedger,
  }
}

function reduceSessionControlEvent(state: TimelineState, event: TimelineSessionControlEvent): TimelineState {
  if (state.processedEventIds[event.id] || !isAfter(event.sequence, state.lastSequence)) return state
  return {
    ...state,
    processedEventIds: { ...state.processedEventIds, [event.id]: true },
    lastEventId: event.id,
    lastSequence: event.sequence,
    sessionControl: reduceTimelineSessionControl(state.sessionControl, event),
  }
}

function reduceMarkerEvent(state: TimelineState, event: TimelineEvent): { state: TimelineSteeringMarkerState; events: readonly TimelineSteeringMarkerEvent[] } | null {
  if (typeof event.sequence !== 'string' || !/^(0|[1-9]\d*)$/.test(event.sequence) || event.sequence.length > 20) return null
  const candidate = event as unknown as TimelineSteeringMarkerEvent
  const combined = [...state.steeringMarkerEvents, candidate]
  const ordered = [...combined].sort((left, right) => {
    const leftSequence = BigInt(left.sequence), rightSequence = BigInt(right.sequence)
    return leftSequence === rightSequence ? left.id.localeCompare(right.id) : leftSequence < rightSequence ? -1 : 1
  })
  if (ordered.length <= STEERING_MARKER_MAX_EVENTS) {
    const reduced = reduceTimelineSteeringMarkers(ordered, { sessionId: state.sessionId })
    return reduced.valid ? { state: reduced.state, events: ordered } : null
  }
  const firstWindow = ordered.length - STEERING_MARKER_MAX_EVENTS
  for (let offset = firstWindow; offset <= ordered.length; offset += 1) {
    const events = ordered.slice(offset)
    const reduced = reduceTimelineSteeringMarkers(events, { sessionId: state.sessionId })
    if (reduced.valid) return { state: reduced.state, events }
  }
  return null
}

function questionTerminalItem(state: TimelineState, item: TimelineItem): TimelineItem {
  if (item.type !== 'question' || TERMINAL_STATUSES.has(item.status)) return item
  const input = parseQuestionInputItem(item, state.sessionId)
  if (!input) return item
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]
    if (event.type !== 'question.answered' && event.type !== 'question.cancelled') continue
    if (event.itemId !== item.id || event.turnId !== item.turnId || event.taskId !== item.taskId) continue
    const terminal = parseQuestionTerminalEvent(event, state.sessionId)
    if (!terminal || terminal.questionId !== input.questionId || terminal.turnId !== input.turnId || terminal.taskId !== input.taskId) continue
    if (item.sequence !== null && !isAtLeast(terminal.sequence, item.sequence)) continue
    const content = isRecord(item.content)
      ? { ...item.content, pending: false, answerAvailable: terminal.status === 'completed', ...(terminal.status === 'interrupted' ? { cancelled: true, cancellationReason: 'interrupt' } : {}) }
      : item.content
    return { ...item, status: terminal.status, content, completedAt: terminal.createdAt ?? item.completedAt, sequence: terminal.sequence }
  }
  return item
}

function isAtLeast(left: string, right: string): boolean {
  return left === right || isAfter(left, right)
}

function reduceDelta(state: TimelineState, value: unknown, preprocessedId?: string): TimelineState {
  const delta = normalizeTimelineEvent(value)
  if (!delta || delta.sessionId !== state.sessionId || !delta.itemId || (preprocessedId === undefined && state.processedEventIds[delta.id])) return state
  if (preprocessedId === undefined && delta.sequence !== null && !isAfter(delta.sequence, state.lastSequence)) return state
  const processedEventIds: Record<string, true> = preprocessedId === undefined
    ? { ...state.processedEventIds, [delta.id]: true }
    : state.processedEventIds
  state = {
    ...state,
    processedEventIds,
    lastSequence: delta.sequence && isAfter(delta.sequence, state.lastSequence) ? delta.sequence : state.lastSequence,
  }
  if (preprocessedId === undefined) state = { ...state, ...appendTimelineEvent(state.events, delta), lastEventId: delta.id }
  const payload = isRecord(delta.payload) ? delta.payload : {}
  const revision = delta.revision ?? numberOrUndefined(payload.revision)
  if (revision === undefined) return state
  const existing = state.itemsById[delta.itemId]
  if (existing && (TERMINAL_STATUSES.has(existing.status) || revision <= existing.revision)) return state
  if (delta.kind === 'delta' && delta.baseRevision !== undefined && delta.baseRevision > (existing?.revision ?? 0)) {
    return { ...state, snapshotRequired: true, connection: 'reconnecting' }
  }
  const item = itemFromTimelineEvent(delta, 'streaming', existing, revision, normalizeTimelineItem)
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

function addUnknownEvent(state: TimelineState, event: TimelineEvent): TimelineState {
  const itemId = `unknown:${event.id}`
  return upsertItem({ ...state, fallbackItems: appendFallbackEvent(state.fallbackItems, event) }, {
    schemaVersion: event.schemaVersion, id: itemId, sessionId: event.sessionId, turnId: event.turnId,
    stepId: null, taskId: event.taskId, type: 'unknown', status: 'completed', phase: 'commentary', revision: 0,
    content: { eventType: event.type, payload: event.payload, opaque: true }, startedAt: event.createdAt ?? null,
    completedAt: event.createdAt ?? null, createdAt: event.createdAt ?? new Date(0).toISOString(),
    updatedAt: event.createdAt ?? new Date(0).toISOString(), source: 'unknown', sequence: event.sequence,
  }, 'unknown')
}

function upsertItem(state: TimelineState, item: TimelineItem, source: TimelineItemSource, replaceContent = false): TimelineState {
  const existing = state.itemsById[item.id]
  if (existing && existing.type === 'question' && TERMINAL_STATUSES.has(existing.status) && !TERMINAL_STATUSES.has(item.status)) return state
  if (existing && source === 'transient' && (TERMINAL_STATUSES.has(existing.status) || item.revision <= existing.revision)) return state
  if (existing && source === 'durable' && existing.sequence && item.sequence && !isAfter(item.sequence, existing.sequence) && item.status !== 'completed') return state
  const nextItem = source === 'transient' && existing
    ? { ...existing, ...item, content: replaceContent ? item.content : mergeContent(existing.content, item.content), source }
    : { ...existing, ...item, source }
  const itemsById = { ...state.itemsById, [item.id]: nextItem }
  const itemIds = Object.values(itemsById).sort(compareItems).map((entry) => entry.id)
  const transientItems = new Map(state.transientItems)
  if (source === 'transient') transientItems.set(item.id, nextItem)
  else transientItems.delete(item.id)
  return { ...state, itemsById, itemIds, transientItems, ...buildIndexes(itemsById) }
}
