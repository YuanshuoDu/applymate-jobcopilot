import { describe, expect, it } from 'vitest'

import { normalizeTimelineEvent, normalizeTimelineItem } from './timeline-event-normalizer'
import { createTimelineState, timelineReducer } from './timeline-reducer'

const envelope = {
  schemaVersion: 'agent-harness.v2', id: 'fact-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'question-item', taskId: null, sequence: '2',
}
const facts = [
  { ...envelope, type: 'question.answered', actor: 'user', payload: { waitKind: 'question', waitId: 'question-1', itemId: 'question-item', turnId: 'turn-1', toolCallId: null, status: 'answered', nextTurnRevision: 3, answerAvailable: true } },
  { ...envelope, type: 'question.cancelled', actor: 'system', payload: { waitKind: 'question', waitId: 'question-1', itemId: 'question-item', toolCallId: null, outcome: 'cancelled', reason: 'interrupt' } },
  ...[
    ['approval.requested', 'orchestrator'], ['approval.resolved', 'user'], ['approval.consumed', 'system'], ['approval.expired', 'system'],
  ].map(([type, actor]) => ({ ...envelope, itemId: null, type, actor, payload: { approvalId: 'approval-1', revision: 1 } })),
]

describe('timeline event normalizers', () => {
  it('normalizes ordinary durable events and items', () => {
    const event = normalizeTimelineEvent({
      schemaVersion: 'agent-harness.v2', id: 'event-1', sessionId: 'session-1', turnId: 'turn-1',
      itemId: 'item-1', taskId: null, type: 'item.completed', actor: 'orchestrator', sequence: '12', payload: { text: 'done' },
    })
    const item = normalizeTimelineItem({
      schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1',
      type: 'agent_message', status: 'completed', content: { text: 'done' }, createdAt: '2026-09-23T00:00:00.000Z',
    })

    expect(event).toMatchObject({ id: 'event-1', sequence: '12', itemId: 'item-1' })
    expect(item).toMatchObject({ id: 'item-1', status: 'completed', source: 'replay' })
  })

  it('keeps strict steering-marker envelope validation', () => {
    const marker = {
      schemaVersion: 'agent-harness.v2', id: 'marker-1', sessionId: 'session-1', turnId: 'turn-1',
      itemId: null, taskId: 'task-1', type: 'agent.steering.marker', actor: 'system', sequence: '12', payload: {},
    }

    expect(normalizeTimelineEvent(marker)).not.toBeNull()
    expect(normalizeTimelineEvent({ ...marker, privateField: true })).toBeNull()
    expect(normalizeTimelineEvent({ ...marker, actor: 'user' })).toBeNull()
  })

  it.each(facts)('preserves valid $type facts and their normalized undefined placeholders', raw => {
    const normalized = normalizeTimelineEvent(raw)
    expect(normalized).toMatchObject({ id: raw.id, type: raw.type, actor: raw.actor, taskId: null, payload: raw.payload })
    expect(normalized).toHaveProperty('kind', undefined)
    expect(normalized).toHaveProperty('baseRevision', undefined)
    expect(normalized).toHaveProperty('revision', undefined)
    expect(normalizeTimelineEvent(normalized)).toEqual(normalized)
  })

  it.each(facts)('rejects malformed raw $type facts before coercion or unknown-key removal', raw => {
    for (const invalid of [
      { actor: null }, { taskId: 123 }, { unknown: undefined }, { revision: '3' }, { baseRevision: '0' },
      { kind: 'delta' }, { correlationId: 123 }, { idempotencyKey: { private: 'metadata' } },
    ]) {
      const normalized = normalizeTimelineEvent({ ...raw, ...invalid })
      expect(normalized).toBeNull()
      const state = createTimelineState('session-1')
      expect(timelineReducer(state, { type: 'event', event: normalized })).toBe(state)
    }
  })

  it.each(facts)('keeps a structurally valid foreign $type fact out of the selected session', raw => {
    const normalized = normalizeTimelineEvent({ ...raw, sessionId: 'foreign-session' })
    expect(normalized).not.toBeNull()
    const state = createTimelineState('session-1')
    expect(timelineReducer(state, { type: 'event', event: normalized })).toBe(state)
  })

  it('leaves ordinary item deltas and final-answer items on their existing normalization path', () => {
    const delta = normalizeTimelineEvent({ ...envelope, type: 'item.delta', actor: 'orchestrator', kind: 'delta', baseRevision: 1, revision: 2, payload: { text: 'next' } })
    expect(delta).toMatchObject({ type: 'item.delta', kind: 'delta', baseRevision: 1, revision: 2 })
    const content = { text: 'Completed response', summary: 'Summary' }
    const final = normalizeTimelineItem({ ...envelope, id: 'final-item', type: 'agent_message', status: 'completed', phase: 'final_answer', revision: 1, content })
    expect(final).toMatchObject({ type: 'agent_message', phase: 'final_answer', status: 'completed', content })
    expect(final?.content).toBe(content)
  })
})
