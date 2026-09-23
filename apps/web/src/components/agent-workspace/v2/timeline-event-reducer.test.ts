import { describe, expect, it } from 'vitest'

import { createTimelineState } from './timeline-reducer'
import { reduceTimelineEvent } from './timeline-event-reducer'

describe('timeline event reducer helper', () => {
  it('keeps ordinary status events in the shared stream and advances lifecycle revision', () => {
    const state = createTimelineState('session-1')
    const next = reduceTimelineEvent(state, {
      schemaVersion: 'agent-harness.v2', id: 'turn-started', sessionId: 'session-1', turnId: 'turn-1',
      itemId: null, taskId: null, type: 'turn.started', actor: 'orchestrator', sequence: '1', payload: {},
    })

    expect(next.lifecycleRevision).toBe(1)
    expect(next.lastEventId).toBe('turn-started')
    expect(next.events.map(event => event.type)).toEqual(['turn.started'])
  })

  it('keeps unknown durable facts visible as opaque fallback items', () => {
    const state = createTimelineState('session-1')
    const next = reduceTimelineEvent(state, {
      schemaVersion: 'agent-harness.v2', id: 'custom-event', sessionId: 'session-1', turnId: 'turn-1',
      itemId: null, taskId: null, type: 'custom.event', actor: 'system', sequence: '2', payload: { safe: true },
    })

    expect(next.fallbackItems.map(event => event.id)).toEqual(['custom-event'])
    expect(next.itemsById['unknown:custom-event']?.content).toMatchObject({ eventType: 'custom.event', opaque: true })
  })
})
