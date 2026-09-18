import { describe, expect, it } from 'vitest'

import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'
import {
  CONTEXT_COMPACTION_ERROR_CODE,
  CONTEXT_COMPACTION_MAX_RECORDS,
  createTimelineContextCompactionState,
  parseTimelineContextCompactionEvent,
  projectContextCompactionRow,
  reduceTimelineContextCompaction,
  selectTimelineContextCompactionProjection,
} from './timeline-context-compaction'
import { createTimelineState, timelineReducer } from './timeline-reducer'

function event(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION,
    id: 'compaction-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1',
    type: 'context.compaction', actor: 'orchestrator', sequence: '1',
    payload: {
      kind: 'context_compacted', observationId: 'context-compacted:step-1', status: 'compacted', stepId: 'step-1',
      idempotencyKey: 'context-compaction:step-1', beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32,
      snapshotRef: 'snapshot-secret-1',
    },
    ...overrides,
  }
}

describe('timeline context compaction parser', () => {
  it('accepts the canonical compacted event and projects only safe metrics', () => {
    const value = event({ correlationId: 'step-1', createdAt: '2026-09-15T00:00:00.000Z' })
    const parsed = parseTimelineContextCompactionEvent(value, 'session-1')
    expect(parsed).toMatchObject({ type: 'context.compaction', actor: 'orchestrator', itemId: null, turnId: 'turn-1', taskId: 'task-1', sequence: '1' })
    expect(parsed?.payload).toMatchObject({ status: 'compacted', snapshotRef: 'snapshot-secret-1' })

    const projected = projectContextCompactionRow({ ...value, sequence: BigInt(1), createdAt: new Date('2026-09-15T00:00:00.000Z') }, 'session-1')
    expect(projected?.payload).toEqual({ kind: 'context_compacted', status: 'compacted', beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32 })
    expect(JSON.stringify(projected)).not.toContain('snapshot-secret-1')
    expect(JSON.stringify(projected)).not.toMatch(/idempotency|errorCode|raw/i)
  })

  it('accepts a strictly redacted payload only with explicit opt-in and enforces status invariants', () => {
    const redacted = (status: string, metrics: Record<string, number>, extra: Record<string, unknown> = {}) => ({
      ...event(),
      payload: { kind: 'context_compacted', status, ...metrics, ...extra },
    })

    expect(parseTimelineContextCompactionEvent(redacted('compacted', { beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32 }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(
      redacted('compacted', { beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32 }),
      'session-1', { allowRedacted: true },
    )?.payload).toEqual({ kind: 'context_compacted', status: 'compacted', beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32 })

    expect(parseTimelineContextCompactionEvent(
      redacted('unchanged', { beforeInputTokens: 20, afterInputTokens: 20, beforeBytes: 80, afterBytes: 80 }),
      'session-1', { allowRedacted: true },
    )?.payload.status).toBe('unchanged')
    expect(parseTimelineContextCompactionEvent(
      redacted('failed', { beforeInputTokens: 20, afterInputTokens: 20, beforeBytes: 80, afterBytes: 80 }),
      'session-1', { allowRedacted: true },
    )?.payload.status).toBe('failed')
    expect(parseTimelineContextCompactionEvent(
      redacted('unchanged', { beforeInputTokens: 20, afterInputTokens: 19, beforeBytes: 80, afterBytes: 80 }),
      'session-1', { allowRedacted: true },
    )).toBeNull()
    expect(parseTimelineContextCompactionEvent(
      redacted('failed', { beforeInputTokens: 20, afterInputTokens: 20, beforeBytes: 80, afterBytes: 81 }),
      'session-1', { allowRedacted: true },
    )).toBeNull()
    expect(parseTimelineContextCompactionEvent(
      redacted('compacted', { beforeInputTokens: 20, afterInputTokens: 20, beforeBytes: 80, afterBytes: 80 }),
      'session-1', { allowRedacted: true },
    )).toBeNull()
    expect(parseTimelineContextCompactionEvent(
      redacted('compacted', { beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 81 }),
      'session-1', { allowRedacted: true },
    )).toBeNull()
    expect(parseTimelineContextCompactionEvent(
      redacted('compacted', { beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32 }, { snapshotRef: 'private' }),
      'session-1', { allowRedacted: true },
    )).toBeNull()
  })

  it('accepts unchanged and failed only with their status-specific optional field', () => {
    const unchanged = event({ payload: { kind: 'context_compacted', observationId: 'context-compacted:step-1', status: 'unchanged', stepId: 'step-1', idempotencyKey: 'context-compaction:step-1', beforeInputTokens: 20, afterInputTokens: 20, beforeBytes: 80, afterBytes: 80 } })
    const failed = event({ payload: { kind: 'context_compacted', observationId: 'context-compacted:step-1', status: 'failed', stepId: 'step-1', idempotencyKey: 'context-compaction:step-1', beforeInputTokens: 20, afterInputTokens: 20, beforeBytes: 80, afterBytes: 80, errorCode: CONTEXT_COMPACTION_ERROR_CODE } })
    expect(parseTimelineContextCompactionEvent(unchanged, 'session-1')?.payload.status).toBe('unchanged')
    expect(parseTimelineContextCompactionEvent(failed, 'session-1')?.payload.errorCode).toBe(CONTEXT_COMPACTION_ERROR_CODE)
  })

  it('requires the canonical envelope idempotency relation when present while allowing legacy omission', () => {
    expect(parseTimelineContextCompactionEvent(event({ idempotencyKey: 'wrong-envelope-key' }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ idempotencyKey: null }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ idempotencyKey: 'turn:turn-1:event:context-compaction:step-1' }), 'session-1')?.id).toBe('compaction-1')
    const child = event({ actor: 'subagent', turnId: 'turn-child', taskId: 'task-child', idempotencyKey: 'task:task-child:event:context-compaction:step-child', payload: { ...(event().payload as Record<string, unknown>), stepId: 'step-child', observationId: 'context-compacted:step-child', idempotencyKey: 'context-compaction:step-child' } })
    expect(parseTimelineContextCompactionEvent(child, 'session-1')?.taskId).toBe('task-child')
    expect(parseTimelineContextCompactionEvent(event(), 'session-1')?.id).toBe('compaction-1')
  })

  it('rejects foreign, malformed, unsafe, and extra-key events', () => {
    expect(parseTimelineContextCompactionEvent(event({ sessionId: 'session-2' }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ actor: 'system' }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ itemId: 'item-1' }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ sequence: '01' }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ extra: true }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ payload: { ...(event().payload as Record<string, unknown>), extra: true } }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ payload: { ...(event().payload as Record<string, unknown>), afterInputTokens: 1.5 } }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ payload: { ...(event().payload as Record<string, unknown>), idempotencyKey: 'wrong' } }), 'session-1')).toBeNull()
    expect(parseTimelineContextCompactionEvent(event({ payload: { ...(event().payload as Record<string, unknown>), status: 'failed', snapshotRef: undefined, errorCode: CONTEXT_COMPACTION_ERROR_CODE } }), 'session-1')).toBeNull()
  })
})

describe('timeline context compaction reducer', () => {
  it('keeps only the latest record per root or child scope and ignores duplicates and older events', () => {
    const first = parseTimelineContextCompactionEvent(event(), 'session-1')!
    const newer = parseTimelineContextCompactionEvent(event({ id: 'compaction-2', sequence: '2', payload: { ...first.payload, beforeInputTokens: 30, afterInputTokens: 10, beforeBytes: 100, afterBytes: 40 } }), 'session-1')!
    const child = parseTimelineContextCompactionEvent(event({ id: 'compaction-child', turnId: 'turn-child', taskId: 'task-child', sequence: '3', payload: { ...first.payload, stepId: 'step-child', observationId: 'context-compacted:step-child', idempotencyKey: 'context-compaction:step-child' } }), 'session-1')!
    const state = reduceTimelineContextCompaction(reduceTimelineContextCompaction(reduceTimelineContextCompaction(createTimelineContextCompactionState(), first), newer), child)
    expect(state.records.map(record => [record.turnId, record.taskId])).toEqual([['turn-child', 'task-child'], ['turn-1', 'task-1']])
    expect(reduceTimelineContextCompaction(state, first)).toBe(state)
    expect(reduceTimelineContextCompaction(state, { ...newer, id: 'older-id', sequence: '1' })).toBe(state)
  })

  it('bounds the ledger to the eight latest scopes', () => {
    let state = createTimelineContextCompactionState()
    for (let index = 1; index <= CONTEXT_COMPACTION_MAX_RECORDS + 2; index += 1) {
      const current = parseTimelineContextCompactionEvent(event({ id: `compaction-${index}`, turnId: `turn-${index}`, taskId: `task-${index}`, sequence: String(index), payload: { ...(event().payload as Record<string, unknown>), stepId: `step-${index}`, observationId: `context-compacted:step-${index}`, idempotencyKey: `context-compaction:step-${index}` } }), 'session-1')!
      state = reduceTimelineContextCompaction(state, current)
    }
    expect(state.records).toHaveLength(CONTEXT_COMPACTION_MAX_RECORDS)
    expect(state.records.map(record => record.sequence)).toEqual(['10', '9', '8', '7', '6', '5', '4', '3'])
  })

  it('does not materialize an unknown item or increment lifecycle refreshes', () => {
    const state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: event() })
    expect(state.contextCompaction.records).toHaveLength(1)
    expect(state.itemsById).toEqual({})
    expect(state.fallbackItems).toEqual([])
    expect(state.lifecycleRevision).toBe(0)
    expect(state.events.map(value => value.id)).toEqual(['compaction-1'])
  })

  it('accepts a valid older sequence when it belongs to a different scope', () => {
    const root = event({ id: 'compaction-root', sequence: '10' })
    const child = event({ id: 'compaction-child-late', turnId: 'turn-child', taskId: 'task-child', sequence: '5', payload: { ...(event().payload as Record<string, unknown>), stepId: 'step-child', observationId: 'context-compacted:step-child', idempotencyKey: 'context-compaction:step-child' } })
    let state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: root })
    state = timelineReducer(state, { type: 'event', event: child })
    expect(state.contextCompaction.records.map(record => record.taskId)).toEqual(['task-1', 'task-child'])
    expect(state.events.map(value => value.id)).toEqual(['compaction-child-late', 'compaction-root'])
    expect(state.lastSequence).toBe('10')
  })

  it('records stale same-scope metadata without changing the bounded projection', () => {
    const first = event({ id: 'compaction-first', sequence: '10' })
    const stale = event({ id: 'compaction-stale', sequence: '9' })
    const state = timelineReducer(timelineReducer(createTimelineState('session-1'), { type: 'event', event: first }), { type: 'event', event: stale })
    expect(state.contextCompaction.records).toHaveLength(1)
    expect(state.contextCompaction.records[0]?.sequence).toBe('10')
    expect(state.events.map(value => value.id)).toEqual(['compaction-stale', 'compaction-first'])
    expect(state.processedEventIds['compaction-stale']).toBe(true)
    expect(state.lastSequence).toBe('10')
    expect(state.lifecycleRevision).toBe(0)
  })

  it('projects only safe generic scope ordinals for the public snapshot', () => {
    const state = reduceTimelineContextCompaction(createTimelineContextCompactionState(), parseTimelineContextCompactionEvent(event(), 'session-1')!)
    const projection = selectTimelineContextCompactionProjection(state)
    expect(projection.records[0]).toMatchObject({ scopeOrdinal: 1, sequence: '1', status: 'compacted', savedTokens: 12 })
    expect(JSON.stringify(projection)).not.toMatch(/eventId|sessionId|turnId|taskId/)
    expect(projection.records[0]).not.toHaveProperty('taskId')
  })
})
