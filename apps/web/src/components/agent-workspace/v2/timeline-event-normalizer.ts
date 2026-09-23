import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

import { STEERING_MARKER_EVENT_TYPE } from './timeline-steering-markers'
import { integer, isRecord, numberOrUndefined, sequence, stringOrNull, timestamp } from './timeline-reducer-utils'
import type { TimelineEvent, TimelineItem, TimelineItemSource } from './timeline-reducer'

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
