import { describe, expect, it } from 'vitest'

import { createTimelineState, type TimelineItem } from './timeline-reducer'
import { upsertTimelineItem } from './timeline-reducer-items'

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type: 'agent_message', status: 'completed', phase: 'final_answer', revision: 2, content: { text: 'new' },
    startedAt: null, completedAt: '2026-09-23T00:00:00.000Z', createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z', source: 'durable', sequence: '5', ...overrides,
  }
}

describe('timeline item state helpers', () => {
  it('does not let a stale replay replace newer live evidence', () => {
    const initial = createTimelineState('session-1')
    const current = upsertTimelineItem(initial, item(), 'durable')
    const stale = upsertTimelineItem(current, item({ sequence: '4', revision: 1, content: { text: 'old' } }), 'replay')

    expect(stale).toBe(current)
    expect(stale.itemsById['item-1']?.content).toEqual({ text: 'new' })
  })

  it('does not regress a terminal question back to pending', () => {
    const initial = createTimelineState('session-1')
    const terminal = upsertTimelineItem(initial, item({ type: 'question', status: 'completed' }), 'durable')
    const replay = upsertTimelineItem(terminal, item({ type: 'question', status: 'started', sequence: '6' }), 'replay')

    expect(replay).toBe(terminal)
    expect(replay.itemsById['item-1']?.status).toBe('completed')
  })
})
