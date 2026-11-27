import { afterEach, describe, expect, it, vi } from 'vitest'

import { projectPublicEventEnvelope } from '@/lib/agent/session/public-tool-identity'
import { redactStreamEventPayload } from '@/lib/agent/session/stream-redaction'

import type { TimelineEvent } from './timeline-reducer'
import { projectSessionPauseBlocker } from './session-pause-blocker-projection'
import { normalizeTimelineEvent } from './timeline-event-normalizer'

const sessionId = 'session-a'
const turnId = 'turn-a'
const requestId = publicId(100)
type PublicPauseEvent = Omit<TimelineEvent, 'causationId'> & {
  causationId: string | null
  correlationId: string
  idempotencyKey: string | null
}

afterEach(() => vi.unstubAllEnvs())

function publicId(value: number): string { return `evt_${value.toString(16).padStart(64, '0')}` }

function control(sequence: string, type: 'session.pause_requested' | 'session.resume_requested', id = publicId(Number(sequence)), turn = turnId): TimelineEvent {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId, turnId: turn, itemId: null, taskId: null,
    type, actor: 'user', sequence,
    payload: { turnId: turn, expectedRevision: 7, requestedAt: '2026-11-23T10:00:00.000Z' },
  }
}

function blocked(
  sequence: string, blockers: readonly string[], pauseRequestEventId = 'raw-internal-pause-id',
  id = publicId(1000 + Number(sequence)), turn = turnId, causationId: string | null = requestId, taskId: string | null = `root-${turn}`,
): TimelineEvent {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId, turnId: turn, itemId: null, taskId,
    type: 'session.pause_blocked', actor: 'orchestrator', sequence, causationId,
    payload: { pauseRequestEventId, blockers },
  }
}

function paused(sequence: string, pauseRequestEventId = 'raw-internal-pause-id', id = publicId(2000 + Number(sequence)), turn = turnId): TimelineEvent {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId, turnId: turn, itemId: null, taskId: `root-${turn}`,
    type: 'session.paused', actor: 'orchestrator', sequence, causationId: requestId,
    payload: { pauseRequestEventId, turnId: turn },
  }
}

describe('session pause blocker projection', () => {
  it('maps only recognized step and external operation blockers', () => {
    expect(projectSessionPauseBlocker([
      control('10', 'session.pause_requested', requestId),
      blocked('11', ['started_external_call', 'streaming_step']),
    ], sessionId)).toEqual({ turnId, reasons: ['step', 'external_operation'] })
  })

  it('maps a private task suffix to a fixed category without returning the suffix', () => {
    const privateTaskId = 'subagent-00000000-0000-4000-8000-000000000042'
    const secondPrivateTaskId = 'subagent-00000000-0000-4000-8000-000000000043'
    const result = projectSessionPauseBlocker([
      control('1', 'session.pause_requested', requestId),
      blocked('2', [`task_interrupt_requested:${privateTaskId}`, `task_not_quiescent:${secondPrivateTaskId}`]),
    ], sessionId)

    expect(result).toEqual({ turnId, reasons: ['child_task'] })
    expect(JSON.stringify(result)).not.toContain(privateTaskId)
    expect(JSON.stringify(result)).not.toContain(secondPrivateTaskId)
  })

  it('maps a root task and Turn lease blocker to recovery', () => {
    expect(projectSessionPauseBlocker([
      control('1', 'session.pause_requested', requestId),
      blocked('2', ['task_recovery_conflict:root-turn-a', 'turn_not_quiescent']),
    ], sessionId, turnId)).toEqual({ turnId, reasons: ['recovery'] })
  })

  it('accepts the canonical rootless pause receipt shape', () => {
    expect(projectSessionPauseBlocker([
      control('1', 'session.pause_requested', requestId),
      blocked('2', ['streaming_step'], 'raw-internal-pause-id', publicId(1002), turnId, requestId, null),
    ], sessionId)).toEqual({ turnId, reasons: ['step'] })
  })

  it('orders replayed events by their durable sequence and ignores exact replay duplicates', () => {
    const request = control('4', 'session.pause_requested', requestId)
    const blocker = blocked('5', ['streaming_step'])
    expect(projectSessionPauseBlocker([blocker, request, blocker], sessionId, turnId)).toEqual({ turnId, reasons: ['step'] })
  })

  it('does not reuse an earlier same-Turn pause after resume and re-pause', () => {
    const pauseOneId = publicId(1), pauseTwoId = publicId(4)
    const pauseOne = control('1', 'session.pause_requested', pauseOneId)
    const oldBlocker = blocked('2', ['streaming_step'], 'raw-pause-one', publicId(1002), turnId, pauseOneId)
    const resume = control('3', 'session.resume_requested', publicId(3))
    const pauseTwo = control('4', 'session.pause_requested', pauseTwoId)
    expect(projectSessionPauseBlocker([pauseOne, oldBlocker, resume, pauseTwo], sessionId, turnId)).toBeNull()
    expect(projectSessionPauseBlocker([
      pauseOne, oldBlocker, resume, pauseTwo, blocked('5', ['started_external_call'], 'raw-pause-two', publicId(1005), turnId, pauseTwoId),
    ], sessionId, turnId)).toEqual({ turnId, reasons: ['external_operation'] })
  })

  it('clears a blocker after the matching pause has settled', () => {
    expect(projectSessionPauseBlocker([
      control('1', 'session.pause_requested', requestId),
      blocked('2', ['streaming_step']),
      paused('3'),
    ], sessionId)).toBeNull()
  })

  it('ignores foreign Sessions and rejects a candidate from another active Turn', () => {
    const otherSession = { ...blocked('3', ['streaming_step']), sessionId: 'session-b', id: 'other-session-blocker' }
    const otherTurn = blocked('2', ['streaming_step'], 'raw-internal-pause-id', publicId(1002), 'turn-b', requestId)
    expect(projectSessionPauseBlocker([control('1', 'session.pause_requested', requestId), otherSession], sessionId, turnId)).toBeNull()
    expect(projectSessionPauseBlocker([control('1', 'session.pause_requested', requestId), otherTurn], sessionId, turnId)).toBeNull()
  })

  it('keeps malformed, ambiguous, or unknown blocker evidence generic', () => {
    const request = control('1', 'session.pause_requested', requestId)
    expect(projectSessionPauseBlocker([request, blocked('2', ['future_blocker'])], sessionId)).toBeNull()
    expect(projectSessionPauseBlocker([request, blocked('2', ['future_blocker']), blocked('3', ['streaming_step'])], sessionId)).toBeNull()
    expect(projectSessionPauseBlocker([request, {
      ...blocked('2', ['streaming_step']), payload: { pauseRequestEventId: 'raw-internal-pause-id', blockers: ['streaming_step'], note: 'private' },
    }], sessionId)).toBeNull()
    expect(projectSessionPauseBlocker([request, blocked('2', ['streaming_step']), blocked('2', ['started_external_call'], 'raw-link', publicId(1003))], sessionId)).toBeNull()
    expect(projectSessionPauseBlocker([request, blocked('2', ['streaming_step'], 'raw-link', publicId(1002), turnId, publicId(999))], sessionId)).toBeNull()
  })

  it('keeps malformed requests and unverified task identities generic', () => {
    const request = control('1', 'session.pause_requested', requestId)
    expect(projectSessionPauseBlocker([request, blocked('2', ['task_not_quiescent:private-task-id'])], sessionId)).toBeNull()
    expect(projectSessionPauseBlocker([{ ...request, payload: { ...request.payload as object, unexpected: true } }, blocked('2', ['streaming_step'])], sessionId)).toBeNull()
  })

  it('binds the public causation alias through projection, redaction, and repeated normalization', () => {
    vi.stubEnv('AUTH_SECRET', 'test-pause-projection-secret')
    const rawRequestId = 'turn:turn-a:event:pause-request:001'
    const request = {
      schemaVersion: 'agent-harness.v2', id: rawRequestId, sessionId, turnId, itemId: null, taskId: null,
      type: 'session.pause_requested', actor: 'user', correlationId: turnId, causationId: null, idempotencyKey: null, sequence: '1',
      payload: { turnId, expectedRevision: 3, requestedAt: '2026-11-23T10:00:00.000Z' },
    }
    const blockedEvent = {
      schemaVersion: 'agent-harness.v2', id: 'turn:turn-a:event:pause-blocked:002', sessionId, turnId, itemId: null, taskId: `root-${turnId}`,
      type: 'session.pause_blocked', actor: 'orchestrator', correlationId: turnId, causationId: rawRequestId, idempotencyKey: null, sequence: '2',
      payload: { pauseRequestEventId: rawRequestId, blockers: ['streaming_step'] },
    }
    const normalizePublicEvent = (event: PublicPauseEvent): TimelineEvent => {
      const projected = projectPublicEventEnvelope(event)
      const payload = redactStreamEventPayload(event.type, projected.payload, {
        sessionId, turnId, itemId: projected.itemId, taskId: event.taskId,
      })
      return normalizeTimelineEvent({ ...projected, payload })!
    }
    const normalizedRequest = normalizePublicEvent(request)
    const normalizedBlocked = normalizePublicEvent(blockedEvent)
    const replayed = [normalizeTimelineEvent(normalizedRequest)!, normalizeTimelineEvent(normalizedBlocked)!]

    expect(normalizedBlocked.id).toMatch(/^evt_[a-f0-9]{64}$/)
    expect(normalizedBlocked.causationId).toBe(normalizedRequest.id)
    expect((normalizedBlocked.payload as { pauseRequestEventId: string }).pauseRequestEventId).toBe(rawRequestId)
    expect(projectSessionPauseBlocker(replayed, sessionId, turnId)).toEqual({ turnId, reasons: ['step'] })
    expect(JSON.stringify(projectSessionPauseBlocker(replayed, sessionId, turnId))).not.toContain(rawRequestId)

    const mismatchedCause = { ...normalizedBlocked, causationId: publicId(999) }
    expect(projectSessionPauseBlocker([normalizedRequest, mismatchedCause], sessionId, turnId)).toBeNull()

    const rawTaskIds = [
      'subagent-12345678-1234-4234-9234-123456789012',
      'subagent-12345679-1234-4234-9234-123456789013',
    ]
    const taskBlockedEvent = {
      ...blockedEvent, id: 'turn:turn-a:event:task-pause-blocked:003', sequence: '3',
      payload: { pauseRequestEventId: rawRequestId, blockers: rawTaskIds.map(id => `task_not_quiescent:${id}`) },
    }
    const normalizedTaskBlock = normalizePublicEvent(taskBlockedEvent)
    const redactedBlockers = (normalizedTaskBlock.payload as { blockers: string[] }).blockers
    expect(redactedBlockers).toEqual([
      'task_not_quiescent:subagent-[REDACTED_PHONE]',
      'task_not_quiescent:subagent-[REDACTED_PHONE]',
    ])
    expect(projectSessionPauseBlocker([normalizedRequest, normalizedTaskBlock], sessionId, turnId))
      .toEqual({ turnId, reasons: ['child_task'] })

    const rawPaused = {
      ...blockedEvent, id: 'turn:turn-a:event:paused:004', type: 'session.paused', sequence: '4',
      payload: { pauseRequestEventId: rawRequestId, turnId },
    }
    expect(projectSessionPauseBlocker([normalizedRequest, normalizedBlocked, normalizePublicEvent(rawPaused)], sessionId, turnId)).toBeNull()
  })
})
