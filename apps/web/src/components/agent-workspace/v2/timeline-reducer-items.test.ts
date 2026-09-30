import { describe, expect, it } from 'vitest'

import { createTimelineState, type TimelineEvent, type TimelineItem } from './timeline-reducer'
import { reduceTimelineDelta, upsertTimelineItem } from './timeline-reducer-items'

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type: 'agent_message', status: 'completed', phase: 'final_answer', revision: 2, content: { text: 'new' },
    startedAt: null, completedAt: '2026-09-23T00:00:00.000Z', createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z', source: 'durable', sequence: '5', ...overrides,
  }
}

function itemDelta(embeddedItem: Record<string, unknown>): TimelineEvent {
  return {
    schemaVersion: 'agent-harness.v2', id: 'delta-1', sessionId: 'session-1', turnId: 'turn-1',
    itemId: 'item-1', taskId: 'root-task', type: 'item.delta', actor: 'system', sequence: '1',
    payload: { revision: 3, item: {
      schemaVersion: 'agent-harness.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1',
      type: 'task_graph', status: 'streaming', revision: 3, content: { nodes: [] }, ...embeddedItem,
    } }, kind: 'delta', revision: 3,
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

  it.each([
    ['foreign session', { sessionId: 'session-2' }],
    ['mismatched item id', { id: 'foreign-item' }],
    ['mismatched turn', { turnId: 'turn-2' }],
  ])('ignores item.delta with a %s embedded item while consuming its event cursor', (_case, embeddedItem) => {
    const next = reduceTimelineDelta(createTimelineState('session-1'), itemDelta(embeddedItem))

    expect(next.itemsById).toEqual({})
    expect(next.processedEventIds['delta-1']).toBe(true)
    expect(next.lastSequence).toBe('1')
    expect(next.lastEventId).toBe('delta-1')
  })

  it('keeps matching TaskGraph and streamed-message item deltas in the projection', () => {
    const initial = createTimelineState('session-1')
    const graph = reduceTimelineDelta(initial, itemDelta({}))
    const messageDelta = {
      ...itemDelta({ type: 'agent_message', content: { text: 'streamed text' } }),
      id: 'message-delta', itemId: 'message-1', sequence: '2', payload: { revision: 1, item: {
        schemaVersion: 'agent-harness.v2', id: 'message-1', sessionId: 'session-1', turnId: 'turn-1',
        type: 'agent_message', status: 'streaming', revision: 1, content: { text: 'streamed text' },
      } }, revision: 1,
    }
    const message = reduceTimelineDelta(graph, messageDelta)

    expect(graph.itemsById['item-1']?.type).toBe('task_graph')
    expect(message.itemsById['message-1']?.content).toEqual({ text: 'streamed text' })
  })
})
