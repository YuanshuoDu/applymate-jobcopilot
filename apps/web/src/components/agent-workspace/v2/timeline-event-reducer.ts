import { isApprovalLedgerEventType, parseApprovalLedgerEvent } from './approval-ledger-parser'
import { reduceApprovalLedger } from './approval-ledger-view'
import { reduceCognitiveAgenda } from './timeline-cognitive-agenda'
import { parseQuestionInputItem, parseQuestionTerminalEvent } from './question-input-parser'
import { normalizeTimelineEvent, normalizeTimelineItem } from './timeline-event-normalizer'
import { reduceTimelineDelta, questionTerminalItem, upsertTimelineItem } from './timeline-reducer-items'
import { appendFallbackEvent, appendTimelineEvent, isAfter, isRecord, itemFromTimelineEvent } from './timeline-reducer-utils'
import { reduceTimelineSteeringMarkers, STEERING_MARKER_EVENT_TYPE, STEERING_MARKER_MAX_EVENTS, type TimelineSteeringMarkerEvent, type TimelineSteeringMarkerState } from './timeline-steering-markers'
import { isSessionControlEventCandidate, parseTimelineSessionControl, reduceTimelineSessionControl, type TimelineSessionControlEvent } from './timeline-session-control'
import type { TimelineEvent, TimelineItem, TimelineState } from './timeline-reducer'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted'])
const KNOWN_EVENT_TYPES = new Set([
  'turn.started', 'turn.wakeup', 'turn.resumed', 'turn.completed', 'turn.failed',
  'task.started', 'task.completed', 'task.interrupted', 'task.failed',
  'step.started', 'step.completed', 'item.started', 'item.delta', 'item.completed', 'item.failed',
  'input.accepted', 'input.consumed', 'tool_call.started', 'tool_call.completed', 'tool_call.failed',
  'policy.decision', 'approval.requested', 'approval.resolved', 'approval.consumed', 'approval.expired',
  'question.answered', 'question.cancelled', 'external_action.reserved', 'stream.overflow', 'cognitive.agenda', STEERING_MARKER_EVENT_TYPE,
])

// Status-only events drive supervisor metadata refreshes. Item deltas are
// intentionally excluded so streamed text does not refetch turns and tasks.
const LIFECYCLE_EVENT_TYPES = new Set([
  'turn.started', 'turn.wakeup', 'turn.resumed', 'turn.completed', 'turn.failed',
  'task.started', 'task.completed', 'task.interrupted', 'task.failed',
  'step.started', 'step.completed', 'item.started', 'item.completed', 'item.failed',
  'tool_call.started', 'tool_call.completed', 'tool_call.failed',
  'approval.requested', 'approval.resolved', 'approval.consumed', 'approval.expired',
  'question.answered', 'question.cancelled', 'external_action.reserved',
])

function isLifecycleEvent(event: TimelineEvent): boolean {
  return LIFECYCLE_EVENT_TYPES.has(event.type) && (!event.type.startsWith('task.') || event.taskId !== null)
}

export function reduceTimelineEvent(state: TimelineState, value: unknown): TimelineState {
  if (isRecord(value) && (value.type === 'question.answered' || value.type === 'question.cancelled')) return reduceQuestionTerminalEvent(state, value)
  if (isRecord(value) && isApprovalLedgerEventType(value.type)) return reduceApprovalEvent(state, value)
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
    lifecycleRevision: isLifecycleEvent(event) ? state.lifecycleRevision + 1 : state.lifecycleRevision,
  }
  if (markerState) return { ...next, steeringMarkers: markerState.state, steeringMarkerEvents: markerState.events }
  if (event.type === 'cognitive.agenda') next = { ...next, cognitiveAgenda: reduceCognitiveAgenda(next.cognitiveAgenda, event) }
  if (event.type === 'stream.overflow') return { ...next, snapshotRequired: true, connection: 'reconnecting' }
  if (event.type === 'item.delta') {
    const existingRevision = state.itemsById[event.itemId ?? '']?.revision ?? 0
    return reduceTimelineDelta(next, { ...event, kind: 'delta', revision: event.revision ?? existingRevision + 1 }, event.id)
  }
  if (event.type === 'item.started' && isRecord(event.payload) && event.payload.waitKind === 'question' && !isRecord(event.payload.item)) return next
  if (!event.itemId) return KNOWN_EVENT_TYPES.has(event.type) ? next : addUnknownEvent(next, event)
  const existing = state.itemsById[event.itemId]
  const status = event.type === 'item.completed' ? 'completed' : event.type === 'item.failed' ? 'failed' : existing?.status ?? 'started'
  if (existing && TERMINAL_STATUSES.has(existing.status) && status !== 'completed') return next
  if (!KNOWN_EVENT_TYPES.has(event.type)) next = { ...next, fallbackItems: appendFallbackEvent(next.fallbackItems, event) }
  const item = itemFromTimelineEvent(event, status, existing, undefined, normalizeTimelineItem)
  if (item?.type === 'question' && isRecord(event.payload) && !parseQuestionInputItem(event.payload.item ?? event.payload, state.sessionId)) return next
  return item ? upsertTimelineItem(next, item, item.source === 'unknown' ? 'unknown' : 'durable') : next
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
  const next: TimelineState = {
    ...state,
    processedEventIds,
    lastSequence: terminal.sequence,
    ...appendTimelineEvent(state.events, event),
    lastEventId: event.id,
    lifecycleRevision: isLifecycleEvent(event) ? state.lifecycleRevision + 1 : state.lifecycleRevision,
  }
  if (!existing) return next
  const content = isRecord(existing.content)
    ? { ...existing.content, pending: false, answerAvailable: terminal.status === 'completed', ...(terminal.status === 'interrupted' ? { cancelled: true, cancellationReason: 'interrupt' } : {}) }
    : existing.content
  const item: TimelineItem = { ...existing, status: terminal.status, content, completedAt: event.createdAt ?? existing.completedAt, updatedAt: event.createdAt ?? existing.updatedAt, sequence: terminal.sequence }
  return upsertTimelineItem(next, item, 'durable')
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
    lifecycleRevision: isLifecycleEvent(event) ? state.lifecycleRevision + 1 : state.lifecycleRevision,
    approvalLedger,
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
  const ordered = [...state.steeringMarkerEvents, candidate].sort((left, right) => {
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

function addUnknownEvent(state: TimelineState, event: TimelineEvent): TimelineState {
  const itemId = `unknown:${event.id}`
  return upsertTimelineItem({ ...state, fallbackItems: appendFallbackEvent(state.fallbackItems, event) }, {
    schemaVersion: event.schemaVersion, id: itemId, sessionId: event.sessionId, turnId: event.turnId,
    stepId: null, taskId: event.taskId, type: 'unknown', status: 'completed', phase: 'commentary', revision: 0,
    content: { eventType: event.type, payload: event.payload, opaque: true }, startedAt: event.createdAt ?? null,
    completedAt: event.createdAt ?? null, createdAt: event.createdAt ?? new Date(0).toISOString(),
    updatedAt: event.createdAt ?? new Date(0).toISOString(), source: 'unknown', sequence: event.sequence,
  }, 'unknown')
}
