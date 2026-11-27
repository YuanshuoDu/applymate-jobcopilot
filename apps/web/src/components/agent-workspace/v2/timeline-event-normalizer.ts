import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

import { isApprovalLedgerEventType, parseApprovalLedgerEvent } from './approval-ledger-parser'
import { parseQuestionTerminalEvent } from './question-input-parser'
import { STEERING_MARKER_EVENT_TYPE } from './timeline-steering-markers'
import { integer, isRecord, numberOrUndefined, sequence, stringOrNull, timestamp } from './timeline-reducer-utils'
import type { TimelineEvent, TimelineItem, TimelineItemSource } from './timeline-reducer'

const PUBLIC_EVENT_ID = /^evt_[a-f0-9]{64}$/

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
  // Validate authoritative wait facts before normalization can discard unknown
  // keys or coerce malformed identity/metadata fields into valid placeholders.
  if ((value.type === 'question.answered' || value.type === 'question.cancelled') && !parseQuestionTerminalEvent(value, value.sessionId)) return null
  if (isApprovalLedgerEventType(value.type) && !parseApprovalLedgerEvent(value, value.sessionId)) return null
  if (value.type === STEERING_MARKER_EVENT_TYPE && (value.actor !== 'system' || value.itemId !== null)) return null
  if (value.type === STEERING_MARKER_EVENT_TYPE && Object.keys(value).some(key => !['schemaVersion', 'id', 'sessionId', 'turnId', 'itemId', 'taskId', 'type', 'actor', 'correlationId', 'causationId', 'idempotencyKey', 'sequence', 'payload', 'createdAt', 'kind', 'baseRevision', 'revision'].includes(key))) return null
  const rawKind = value.kind
  if (rawKind !== undefined && rawKind !== 'delta' && rawKind !== 'snapshot') return null
  const kind = rawKind === 'delta' || rawKind === 'snapshot' ? rawKind : undefined
  const rawSequence = value.sequence
  if (rawSequence !== null && rawSequence !== undefined && sequence(rawSequence) === null) return null
  const pauseTransition = value.type === 'session.pause_blocked' || value.type === 'session.paused'
  return {
    schemaVersion: typeof value.schemaVersion === 'string' ? value.schemaVersion : AGENT_STREAM_SCHEMA_VERSION,
    id: value.id, sessionId: value.sessionId, turnId: value.turnId,
    itemId: stringOrNull(value.itemId), taskId: stringOrNull(value.taskId), type: value.type,
    actor: typeof value.actor === 'string' ? value.actor : 'system', sequence: sequence(rawSequence),
    payload: value.payload ?? null, createdAt: timestamp(value.createdAt) ?? undefined, kind,
    ...(pauseTransition ? { causationId: typeof value.causationId === 'string' && PUBLIC_EVENT_ID.test(value.causationId) ? value.causationId : null } : {}),
    baseRevision: numberOrUndefined(value.baseRevision), revision: numberOrUndefined(value.revision),
  }
}
