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

  it('refreshes supervisor metadata for TaskGraph item deltas but not streamed text', () => {
    const state = createTimelineState('session-1')
    const ordinaryDelta = reduceTimelineEvent(state, {
      schemaVersion: 'agent-harness.v2', id: 'text-delta', sessionId: 'session-1', turnId: 'turn-1',
      itemId: 'message-1', taskId: null, type: 'item.delta', actor: 'orchestrator', sequence: '1',
      payload: { revision: 1, item: {
        schemaVersion: 'agent-harness.v2', id: 'message-1', sessionId: 'session-1', turnId: 'turn-1',
        type: 'agent_message', status: 'streaming', revision: 1, content: { text: 'still streaming' },
      } },
    })

    expect(ordinaryDelta.lifecycleRevision).toBe(0)

    const taskGraphDelta = reduceTimelineEvent(ordinaryDelta, {
      schemaVersion: 'agent-harness.v2', id: 'task-graph-delta', sessionId: 'session-1', turnId: 'turn-1',
      itemId: 'graph-1', taskId: 'root-task', type: 'item.delta', actor: 'system', sequence: '2',
      payload: { kind: 'lifecycle', revision: 2, item: {
        schemaVersion: 'agent-harness.v2', id: 'graph-1', sessionId: 'session-1', turnId: 'turn-1',
        type: 'task_graph', status: 'streaming', revision: 2,
        content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [] },
      } },
    })

    expect(taskGraphDelta.lifecycleRevision).toBe(1)
    expect(taskGraphDelta.itemsById['graph-1']?.type).toBe('task_graph')
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
