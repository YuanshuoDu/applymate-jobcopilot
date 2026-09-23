import { describe, expect, it } from 'vitest'

import { normalizeTimelineEvent, normalizeTimelineItem } from './timeline-event-normalizer'

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
})
