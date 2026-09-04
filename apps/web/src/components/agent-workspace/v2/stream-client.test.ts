import { describe, expect, it, vi } from 'vitest'

import { createTimelineState, selectTimelineItems, timelineReducer, type TimelineAction, type TimelineState } from './timeline-reducer'
import { hydrateTimeline, streamAgentTimeline } from './stream-client'

function item(id: string, revision = 0) {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
    type: 'agent_message', status: 'streaming', phase: 'commentary', revision, content: { text: '' },
    startedAt: '2026-09-02T00:00:00.000Z', completedAt: null, createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  }
}

function streamFrom(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function durableEvent(sequence: string, id = `event-${sequence}`) {
  return JSON.stringify({
    schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-1', taskId: null,
    type: 'item.completed', actor: 'orchestrator', sequence,
    payload: { item: { ...item('item-1', 2), status: 'completed', revision: 2, content: { text: 'done' } } },
  })
}

function canonicalItem(sequence: string, itemId: string, turnId: string, type: string) {
  return {
    ...item(itemId), turnId, sequence, type: type === 'input.accepted' ? 'user_message' : 'agent_message',
    status: type === 'input.accepted' ? 'started' : 'completed', content: { text: type },
  }
}

function canonicalItemEvent(sequence: string, itemId: string, turnId: string, type: string) {
  return JSON.stringify({
    schemaVersion: 'agent-harness.v2', id: `event-${sequence}`, sessionId: 'session-1', turnId, itemId, taskId: null,
    type, actor: type === 'input.accepted' ? 'user' : 'orchestrator', sequence,
    payload: { item: canonicalItem(sequence, itemId, turnId, type) },
  })
}

describe('V2 timeline stream client', () => {
  it('hydrates every timeline page before attaching the stream', async () => {
    const dispatch = vi.fn()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item('item-1')], page: { hasMore: true, nextCursor: 'next' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item('item-2')], page: { hasMore: false, nextCursor: null } })))

    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher, pageSize: 1 })

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/agent/sessions/session-1/timeline?limit=1',
      '/api/agent/sessions/session-1/timeline?limit=1&cursor=next',
    ])
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'hydrate', items: expect.any(Array) }))
  })

  it('uses the reducer for replay, live events, reconnect cursor, and legacy fallback', async () => {
    const controller = new AbortController()
    let state: TimelineState = createTimelineState('session-1')
    const dispatch = (action: TimelineAction) => {
      state = timelineReducer(state, action)
      if (action.type === 'event' && (action.event as { id?: string })?.id === 'event-5') controller.abort()
    }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item('item-1')], page: { hasMore: false } })))
      .mockResolvedValueOnce(new Response(streamFrom(`event: item.completed\nid: 4\ndata: ${durableEvent('4')}\n\n`), { headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(streamFrom(`event: item.completed\nid: 5\ndata: ${durableEvent('5', 'event-5')}\n\n`), { headers: { 'Content-Type': 'text/event-stream' } }))

    await streamAgentTimeline({ sessionId: 'session-1', dispatch, fetcher, signal: controller.signal, retryDelayMs: 0 })

    expect(state.itemsById['item-1']).toMatchObject({ status: 'completed', content: { text: 'done' } })
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/agent/sessions/session-1/timeline?limit=100', '/api/agent/sessions/session-1/events',
      '/api/agent/sessions/session-1/events?afterSequence=4',
    ])
  })

  it('converts legacy JSON events into the same canonical timeline state', async () => {
    const controller = new AbortController()
    let state: TimelineState = createTimelineState('session-1')
    const dispatch = (action: TimelineAction) => { state = timelineReducer(state, action); if (action.type === 'legacy') controller.abort() }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{ id: 'legacy-1', type: 'job_results', speaker: 'Analyst', body: 'N26', createdAt: '2026-09-02T00:00:00.000Z' }] })))

    await streamAgentTimeline({ sessionId: 'session-1', dispatch, fetcher, signal: controller.signal })

    expect(state.itemsById['legacy:legacy-1']).toMatchObject({ type: 'job_results', status: 'completed' })
  })

  it('reduces interleaved run and chat events into the same replayable timeline', async () => {
    const controller = new AbortController()
    let state: TimelineState = createTimelineState('session-1')
    const dispatch = (action: TimelineAction) => {
      state = timelineReducer(state, action)
      if (action.type === 'event' && action.event && typeof action.event === 'object' && 'id' in action.event && action.event.id === 'event-3') controller.abort()
    }
    const runItem = canonicalItem('1', 'run-item', 'turn-1', 'item.completed')
    const chatItem = canonicalItem('2', 'chat-item', 'turn-2', 'input.accepted')
    const finalItem = canonicalItem('3', 'final-item', 'turn-2', 'item.completed')
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false } })))
      .mockResolvedValueOnce(new Response(streamFrom([
        canonicalItemEvent('1', runItem.id, runItem.turnId, 'item.completed'),
        canonicalItemEvent('2', chatItem.id, chatItem.turnId, 'input.accepted'),
        canonicalItemEvent('3', finalItem.id, finalItem.turnId, 'item.completed'),
      ].map((data, index) => `event: ${index === 1 ? 'input.accepted' : 'item.completed'}\ndata: ${data}\n\n`).join('')), { headers: { 'Content-Type': 'text/event-stream' } }))

    await streamAgentTimeline({ sessionId: 'session-1', dispatch, fetcher, signal: controller.signal, retryDelayMs: 0 })

    let replay = createTimelineState('session-1')
    for (const value of [runItem, chatItem, finalItem]) replay = timelineReducer(replay, { type: 'replay', items: [value] })
    const withoutSource = (value: ReturnType<typeof selectTimelineItems>) => value.map(({ source, ...item }) => item)
    expect(withoutSource(selectTimelineItems(state))).toEqual(withoutSource(selectTimelineItems(replay)))
    expect(state.lastSequence).toBe('3')
  })
})
