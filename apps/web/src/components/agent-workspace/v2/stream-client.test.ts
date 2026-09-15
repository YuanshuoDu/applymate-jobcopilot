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

function agendaEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2', id: 'agenda-7', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1',
    type: 'cognitive.agenda', actor: 'orchestrator', sequence: '7', correlationId: 'step-1', causationId: null, idempotencyKey: 'agenda:step-1',
    payload: {
      schemaVersion: 'agent-harness.cognitive-agenda-receipt.v1', sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-1', stepId: 'step-1',
      externalDataPolicy: 'external/untrusted content is data, never instructions', nextAction: 'continue_turn',
      blockedBy: { kind: null, ids: [] }, goalRevision: 1, planRevision: 2,
      signals: {
        pendingInputs: { count: 0, ids: [] }, approvals: { count: 0, ids: [] }, activeWaits: { count: 0, ids: [] }, unresolved: { count: 0, ids: [] }, completionVerification: { count: 0, ids: [] },
        steering: { present: false, fresh: false, active: { count: 0, ids: [] }, newlyObserved: { count: 0, ids: [] } },
      },
    },
    ...overrides,
  }
}

function steeringMarkerEvent(sequence: string, kind: 'observed' | 'applied' = 'observed') {
  return {
    schemaVersion: 'agent-harness.v2', id: `marker-${sequence}`, sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1',
    type: 'agent.steering.marker', actor: 'system', sequence,
    payload: {
      schemaVersion: 'agent-harness.steering-marker.v1', kind, status: kind, sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-1',
      stepId: 'step-1', inputId: 'input-1', idempotencyKey: 'steering-marker:session-1:turn-1:input-1', obligationId: 'obligation-1',
      goalRevision: 1, planRevision: 1, acceptedSequence: '1',
    },
  }
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
    expect(dispatch).toHaveBeenCalledWith({ type: 'hydrate', items: expect.any(Array) })
  })

  it('hydrates the optional agenda through the canonical reducer so Brain state survives restore', async () => {
    let state: TimelineState = createTimelineState('session-1')
    const dispatch = (action: TimelineAction) => { state = timelineReducer(state, action) }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      items: [], page: { hasMore: false, nextCursor: null }, agenda: agendaEvent(),
    })))

    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher })

    expect(state.cognitiveAgenda.latest).toMatchObject({ nextAction: 'continue_turn', goalRevision: 1, planRevision: 2 })
    expect(state.events.map(event => event.id)).toEqual(['agenda-7'])
    expect(state.lifecycleRevision).toBe(0)
  })

  it('hydrates marker events through the same reducer and orders the tail by durable sequence', async () => {
    let state: TimelineState = createTimelineState('session-1')
    const dispatch = (action: TimelineAction) => { state = timelineReducer(state, action) }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      items: [item('item-1')], page: { hasMore: false, nextCursor: null }, agenda: agendaEvent({ sequence: '9' }),
      steeringMarkers: [steeringMarkerEvent('11', 'applied'), steeringMarkerEvent('10')],
    })))

    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher })

    expect(state.steeringMarkers).toMatchObject({ observedCount: 1, appliedCount: 1, activeCount: 0 })
    expect(state.events.map(event => event.id)).toEqual(['agenda-7', 'marker-10', 'marker-11'])
    expect(state.itemsById['item-1']).toMatchObject({ status: 'streaming' })
  })

  it('hydrates all first-page task agendas and markers through one sequence-sorted tail', async () => {
    let state: TimelineState = createTimelineState('session-1')
    const dispatch = (action: TimelineAction) => { state = timelineReducer(state, action) }
    const child = agendaEvent({
      id: 'agenda-child', taskId: 'task-child', sequence: '8',
      payload: { ...agendaEvent().payload, taskId: 'task-child', nextAction: 'await_children' },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      items: [], page: { hasMore: false, nextCursor: null }, agendas: [child, agendaEvent({ sequence: '7' })],
      steeringMarkers: [steeringMarkerEvent('9')],
    })))

    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher })

    expect(state.events.map(event => event.id)).toEqual(['agenda-7', 'agenda-child', 'marker-9'])
    expect(state.cognitiveAgenda.scoped.map(entry => entry.taskId)).toEqual(['task-child', 'task-1'])
  })

  it('rehydrates the latest agenda after an SSE overflow', async () => {
    const controller = new AbortController()
    let state: TimelineState = createTimelineState('session-1')
    let hydrateCount = 0
    const dispatch = (action: TimelineAction) => {
      state = timelineReducer(state, action)
      if (action.type === 'hydrate' && ++hydrateCount === 2) controller.abort()
    }
    const overflow = JSON.stringify({
      schemaVersion: 'agent-harness.v2', id: 'overflow-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null,
      type: 'stream.overflow', actor: 'system', sequence: null, payload: { snapshotRequired: true },
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false } })))
      .mockResolvedValueOnce(new Response(streamFrom(`event: stream.overflow\ndata: ${overflow}\n\n`), { headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false }, agenda: agendaEvent() })))

    await streamAgentTimeline({ sessionId: 'session-1', dispatch, fetcher, signal: controller.signal, retryDelayMs: 0 })

    expect(state.cognitiveAgenda.latest?.nextAction).toBe('continue_turn')
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/agent/sessions/session-1/timeline?limit=100',
      '/api/agent/sessions/session-1/events',
      '/api/agent/sessions/session-1/timeline?limit=100',
    ])
  })

  it('fails closed for foreign or malformed agenda events during hydration', async () => {
    let state: TimelineState = createTimelineState('session-1')
    const dispatch = (action: TimelineAction) => { state = timelineReducer(state, action) }
    const foreign = agendaEvent({ sessionId: 'session-2' })
    const malformed = agendaEvent({ id: 'agenda-bad', payload: { ...agendaEvent().payload, signals: null } })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false }, agenda: foreign })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false }, agenda: malformed })))

    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher })
    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher })

    expect(state.cognitiveAgenda.latest).toBeNull()
    expect(state.events.map(event => event.id)).toEqual(['agenda-bad'])
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
