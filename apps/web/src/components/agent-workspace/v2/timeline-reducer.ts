/** CANONICAL Phase 9 timeline state root — do not duplicate. See #459. */

import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import { createApprovalLedgerState, type ApprovalLedgerState } from './approval-ledger-view'
import { createCognitiveAgendaState, type TimelineCognitiveAgendaState } from './timeline-cognitive-agenda'
import { normalizeTimelineEvent } from './timeline-event-normalizer'
import { reduceTimelineEvent } from './timeline-event-reducer'
import { reduceTimelineDelta, reduceTimelineItems, upsertTimelineItem } from './timeline-reducer-items'
import { appendTimelineEvent, isAfter, isRecord, stringOrNull } from './timeline-reducer-utils'
import { emptyTimelineSteeringMarkerState, type TimelineSteeringMarkerEvent, type TimelineSteeringMarkerState } from './timeline-steering-markers'
export { normalizeTimelineEvent, normalizeTimelineItem } from './timeline-event-normalizer'

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
  lifecycleRevision: number
  cognitiveAgenda: TimelineCognitiveAgendaState
  approvalLedger: ApprovalLedgerState
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

const RETIRED_PLAN_EVENT_TYPES = new Set(['plan.revision', 'plan.command', 'plan.observation', 'plan.task_graph'])

export function createTimelineState(sessionId: string): TimelineState {
  return {
    sessionId, events: [], byId: new Map(), byTurnId: new Map(), byToolCallId: new Map(), lastEventId: null,
    transientItems: new Map(), fallbackItems: [],
    itemIds: [], itemsById: {}, itemIdsByTurnId: {}, itemIdsByTaskId: {},
    processedEventIds: {}, lastSequence: null, lifecycleRevision: 0, cognitiveAgenda: createCognitiveAgendaState(sessionId), approvalLedger: createApprovalLedgerState(sessionId), steeringMarkers: emptyTimelineSteeringMarkerState(), steeringMarkerEvents: [], connection: 'idle', snapshotRequired: false,
  }
}

export function selectTimelineItems(state: TimelineState): TimelineItem[] {
  return state.itemIds.map((id) => state.itemsById[id]).filter((item): item is TimelineItem => Boolean(item))
}

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case 'hydrate': {
      let next = reduceTimelineItems(state, action.items, 'replay')
      for (const event of action.tail ?? []) next = reduceEvent(next, event)
      for (const delta of action.deltas ?? []) next = reduceTimelineDelta(next, delta)
      return { ...next, snapshotRequired: false }
    }
    case 'replay': return reduceTimelineItems(state, action.items, 'replay')
    case 'event': return reduceEvent(state, action.event)
    case 'delta': return reduceTimelineDelta(state, action.delta)
    case 'legacy': return reduceLegacy(state, action.event)
    case 'connected': return { ...state, connection: 'connected' }
    case 'disconnected': return { ...state, connection: 'reconnecting' }
    case 'snapshot-required': return { ...state, snapshotRequired: true, connection: 'reconnecting' }
  }
}

function reduceEvent(state: TimelineState, value: unknown): TimelineState {
  if (isRecord(value) && typeof value.type === 'string' && RETIRED_PLAN_EVENT_TYPES.has(value.type)) return advanceRetiredPlanEventCursor(state, value)
  return reduceTimelineEvent(state, value)
}

function advanceRetiredPlanEventCursor(state: TimelineState, value: Record<string, unknown>): TimelineState {
  const event = normalizeTimelineEvent(value)
  if (!event || event.sessionId !== state.sessionId || event.sequence === null || state.processedEventIds[event.id] || !isAfter(event.sequence, state.lastSequence)) return state
  return {
    ...state,
    processedEventIds: { ...state.processedEventIds, [event.id]: true },
    lastEventId: event.id,
    lastSequence: event.sequence,
  }
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
  return upsertTimelineItem(state, item, 'replay')
}
