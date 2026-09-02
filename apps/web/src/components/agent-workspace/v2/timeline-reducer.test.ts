import { describe, expect, it } from 'vitest'

import { createTimelineState, selectTimelineItems, timelineReducer, type TimelineEvent, type TimelineItem } from './timeline-reducer'

const baseItem = (id: string, overrides: Partial<TimelineItem> = {}): TimelineItem => ({
  schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', stepId: null,
  taskId: null, type: 'agent_message', status: 'streaming', phase: 'commentary', revision: 0,
  content: { text: '' }, startedAt: '2026-09-01T00:00:00.000Z', completedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', source: 'replay', sequence: null,
  ...overrides,
})

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  schemaVersion: 'agent-harness.v2', id: 'event-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-1',
  taskId: null, type: 'item.delta', actor: 'orchestrator', sequence: null, payload: { text: 'delta' },
  kind: 'delta', revision: 1, ...overrides,
})

describe('timeline reducer', () => {
  it('hydrates the durable snapshot and merges transient tail into one indexed projection', () => {
    const state = timelineReducer(createTimelineState('session-1'), {
      type: 'hydrate', items: [baseItem('item-1')], deltas: [event({ payload: { text: 'working' }, revision: 1 })],
    })

    expect(selectTimelineItems(state)).toHaveLength(1)
    expect(state.itemsById['item-1'].content).toEqual({ text: 'working' })
    expect(state.itemsById['item-1'].source).toBe('transient')
  })

  it('applies a durable item.delta event delivered through the event path', () => {
    let state = timelineReducer(createTimelineState('session-1'), { type: 'replay', items: [baseItem('item-1')] })
    state = timelineReducer(state, { type: 'event', event: event({ kind: undefined, revision: undefined, payload: { itemId: 'item-1', status: 'streaming', content: { text: 'durable delta' } } }) })
    expect(state.itemsById['item-1']).toMatchObject({ revision: 1, content: { text: 'durable delta' } })
    expect(state.processedEventIds['event-1']).toBe(true)
  })

  it('replaces transient content with a completed authoritative item and ignores duplicates/out-of-order regressions', () => {
    let state = timelineReducer(createTimelineState('session-1'), { type: 'replay', items: [baseItem('item-1', { revision: 2 })] })
    state = timelineReducer(state, { type: 'delta', delta: event({ id: 'delta-1', revision: 3, payload: { text: 'partial' } }) })
    const completed = baseItem('item-1', { status: 'completed', revision: 4, content: { text: 'authoritative' }, source: 'durable', sequence: '8', completedAt: '2026-09-01T00:00:01.000Z', updatedAt: '2026-09-01T00:00:01.000Z' })
    state = timelineReducer(state, { type: 'event', event: event({ id: 'event-completed', type: 'item.completed', kind: undefined, revision: undefined, sequence: '8', payload: completed }) })
    state = timelineReducer(state, { type: 'event', event: event({ id: 'event-started-late', type: 'item.started', kind: undefined, sequence: '7', payload: { text: 'old' } }) })
    state = timelineReducer(state, { type: 'event', event: event({ id: 'event-completed', type: 'item.completed', kind: undefined, sequence: '8', payload: completed }) })

    expect(selectTimelineItems(state)).toHaveLength(1)
    expect(state.itemsById['item-1']).toMatchObject({ status: 'completed', content: { text: 'authoritative' }, revision: 4 })
    expect(state.lastSequence).toBe('8')
  })

  it('keeps reconnect non-terminal and safely materializes unknown items', () => {
    let state = timelineReducer(createTimelineState('session-1'), { type: 'connected' })
    state = timelineReducer(state, { type: 'disconnected' })
    state = timelineReducer(state, { type: 'event', event: event({ id: 'future-1', itemId: 'future-item', type: 'future.item.v3', sequence: '12', kind: undefined, payload: { value: 1 } }) })

    expect(state.connection).toBe('reconnecting')
    expect(state.itemsById['future-item']).toMatchObject({ type: 'unknown', status: 'started', source: 'unknown' })
    expect(state.itemsById['future-item'].content).toMatchObject({ eventType: 'future.item.v3', opaque: true })
  })

  it('produces the same state for replay and live delivery of the same events', () => {
    const items = [baseItem('item-1')]
    const events = [
      event({ id: 'delta-1', revision: 1, payload: { text: 'hello' } }),
      event({ id: 'completed-1', type: 'item.completed', kind: undefined, sequence: '4', payload: baseItem('item-1', { status: 'completed', revision: 1, content: { text: 'hello' }, source: 'durable' }) }),
    ]
    let replay = timelineReducer(createTimelineState('session-1'), { type: 'hydrate', items, tail: events })
    let live = timelineReducer(createTimelineState('session-1'), { type: 'replay', items })
    for (const current of events) live = timelineReducer(live, { type: current.kind ? 'delta' : 'event', [current.kind ? 'delta' : 'event']: current } as never)
    expect(live).toEqual(replay)
  })

  it('replaces a snapshot and requests recovery when a delta has a revision gap', () => {
    let state = timelineReducer(createTimelineState('session-1'), { type: 'replay', items: [baseItem('item-1', { revision: 1, content: { text: 'old', stale: true } })] })
    state = timelineReducer(state, { type: 'delta', delta: event({ id: 'delta-gap', revision: 3, baseRevision: 2, payload: { content: { text: 'gap' } } }) })
    expect(state.snapshotRequired).toBe(true)
    expect(state.itemsById['item-1'].content).toEqual({ text: 'old', stale: true })

    state = timelineReducer(state, { type: 'delta', delta: event({ id: 'snapshot-2', kind: 'snapshot', revision: 2, baseRevision: 0, payload: { content: { text: 'fresh' } } }) })
    expect(state.snapshotRequired).toBe(false)
    expect(state.itemsById['item-1'].content).toEqual({ text: 'fresh' })
  })
})
