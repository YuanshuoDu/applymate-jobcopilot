import { describe, expect, it } from 'vitest'

import { createTimelineState, timelineReducer } from './timeline-reducer'
import { timelineItemsForSession } from './use-agent-timeline'

describe('timeline session projection', () => {
  it('discards state from a previous session before rendering a switch', () => {
    const state = timelineReducer(createTimelineState('session-a'), {
      type: 'replay',
      items: [{
        schemaVersion: 'agent-harness.v2', id: 'item-a', sessionId: 'session-a', turnId: 'turn-a', stepId: null, taskId: null,
        type: 'agent_message', status: 'completed', phase: 'final_answer', revision: 1, content: { text: 'A' },
        createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:00:00.000Z', startedAt: null, completedAt: null,
      }],
    })

    expect(timelineItemsForSession(state, 'session-a')).toHaveLength(1)
    expect(timelineItemsForSession(state, 'session-b')).toEqual([])
    expect(timelineItemsForSession(state, null)).toEqual([])
  })

  it('advances lifecycle revision for status events without treating deltas as metadata changes', () => {
    const base = createTimelineState('session-a')
    const event = (id: string, sequence: string, type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
      schemaVersion: 'agent-harness.v2', id, sessionId: 'session-a', turnId: 'turn-a', itemId: null, taskId: null,
      type, actor: 'fixture', sequence, payload, ...extra,
    })
    const started = timelineReducer(base, { type: 'event', event: event('started', '1', 'turn.started', { status: 'in_progress' }) })
    const delta = timelineReducer(started, {
      type: 'delta',
      delta: event('delta', '2', 'item.delta', { text: 'streaming' }, { itemId: 'item-a', kind: 'delta', revision: 1 }),
    })

    expect(started.lifecycleRevision).toBe(1)
    expect(delta.lifecycleRevision).toBe(1)
  })
})
