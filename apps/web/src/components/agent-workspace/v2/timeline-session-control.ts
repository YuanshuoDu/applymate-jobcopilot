import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

import { isRecord, sequence } from './timeline-reducer-utils'

export type TimelineSessionControlType = 'session.paused' | 'session.resumed'
export type TimelineSessionControlGate = 'open' | 'user_paused'

export type TimelineSessionControlPayload =
  | {
      sessionId: string
      operation: 'pause'
      previousGate: 'open'
      nextGate: 'user_paused'
      controlRevision: number
      pausedAt: string
    }
  | {
      sessionId: string
      operation: 'resume'
      previousGate: 'user_paused'
      nextGate: 'open'
      controlRevision: number
      pausedAt: null
    }

export interface TimelineSessionControlEvent {
  schemaVersion: typeof AGENT_STREAM_SCHEMA_VERSION
  id: string
  sessionId: string
  turnId: null
  itemId: null
  taskId: null
  type: TimelineSessionControlType
  actor: 'system'
  correlationId: string
  causationId: null
  idempotencyKey: string
  sequence: string
  payload: TimelineSessionControlPayload
}

export interface TimelineSessionControlState {
  controlGate: TimelineSessionControlGate
  controlRevision: number
  pausedAt: string | null
}

const ENVELOPE_KEYS = [
  'schemaVersion', 'id', 'sessionId', 'turnId', 'itemId', 'taskId', 'type', 'actor',
  'correlationId', 'causationId', 'idempotencyKey', 'sequence', 'payload',
] as const
const PAYLOAD_KEYS = ['sessionId', 'operation', 'previousGate', 'nextGate', 'controlRevision', 'pausedAt'] as const

export function isSessionControlEventCandidate(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.type === 'session.paused' || value.type === 'session.resumed')
}

export function parseTimelineSessionControl(value: unknown, sessionId: string): TimelineSessionControlEvent | null {
  if (!isSessionControlEventCandidate(value) || !isBoundedText(sessionId) || !hasExactKeys(value, ENVELOPE_KEYS)) return null
  if (value.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || value.sessionId !== sessionId ||
    !isBoundedText(value.id) || value.turnId !== null || value.itemId !== null || value.taskId !== null ||
    value.actor !== 'system' || value.correlationId !== sessionId || value.causationId !== null ||
    !isBoundedText(value.idempotencyKey)) return null
  const eventSequence = sequence(value.sequence)
  if (eventSequence === null) return null

  const payload = isRecord(value.payload) ? value.payload : null
  if (!payload || !hasExactKeys(payload, PAYLOAD_KEYS) || payload.sessionId !== sessionId) return null
  const controlRevision = payload.controlRevision
  if (typeof controlRevision !== 'number' || !Number.isSafeInteger(controlRevision) || controlRevision < 1 || controlRevision > 2_147_483_647) return null

  const common = {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION as typeof AGENT_STREAM_SCHEMA_VERSION,
    id: value.id,
    sessionId,
    turnId: null,
    itemId: null,
    taskId: null,
    actor: 'system' as const,
    correlationId: sessionId,
    causationId: null,
    idempotencyKey: value.idempotencyKey,
    sequence: eventSequence,
  }
  if (value.type === 'session.paused' && payload.operation === 'pause' && payload.previousGate === 'open' &&
    payload.nextGate === 'user_paused' && typeof payload.pausedAt === 'string' && isTimestamp(payload.pausedAt)) {
    return { ...common, type: value.type, payload: {
      sessionId, operation: 'pause', previousGate: 'open', nextGate: 'user_paused',
      controlRevision, pausedAt: payload.pausedAt,
    } }
  }
  if (value.type === 'session.resumed' && payload.operation === 'resume' && payload.previousGate === 'user_paused' &&
    payload.nextGate === 'open' && payload.pausedAt === null) {
    return { ...common, type: value.type, payload: {
      sessionId, operation: 'resume', previousGate: 'user_paused', nextGate: 'open',
      controlRevision, pausedAt: null,
    } }
  }
  return null
}

export function createTimelineSessionControlState(): TimelineSessionControlState {
  return { controlGate: 'open', controlRevision: 0, pausedAt: null }
}

export function reduceTimelineSessionControl(
  state: TimelineSessionControlState,
  event: TimelineSessionControlEvent,
): TimelineSessionControlState {
  if (event.payload.controlRevision <= state.controlRevision) return state
  return {
    controlGate: event.payload.nextGate,
    controlRevision: event.payload.controlRevision,
    pausedAt: event.payload.pausedAt,
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
}
