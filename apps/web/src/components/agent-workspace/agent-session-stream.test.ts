import { describe, expect, it, vi } from 'vitest'

import { streamAgentSessionEvents } from './agent-session-stream'

function streamFrom(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe('agent session stream protocol bridge', () => {
  it('keeps the legacy JSON restore path when the server selects legacy', async () => {
    const events = [] as Array<{ id: string; type: string }>
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ events: [
      { id: 'legacy-1', taskId: null, type: 'job_results', speaker: 'Analyst', title: 'Jobs', body: 'N26', data: { count: 1 }, durationMs: null, createdAt: '2026-09-01T00:00:00.000Z' },
    ] })))

    await streamAgentSessionEvents({ sessionId: 'session-1', fetcher, onEvent: event => events.push(event) })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: 'legacy-1', type: 'job_results', speaker: 'Analyst', body: 'N26' })
    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session-1/events', { signal: undefined })
  })

  it('maps V2 legacy payloads and reconnects with the durable sequence cursor', async () => {
    const controller = new AbortController()
    const events: Array<{ id: string; body: string }> = []
    const envelope = (id: string, sequence: string, body: string) => JSON.stringify({
      schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', itemId: `item-${id}`,
      taskId: null, type: 'item.completed', actor: 'orchestrator', sequence,
      payload: { legacy: { type: 'orchestrator_plan', speaker: 'Orchestrator', title: 'Plan', body, data: null } },
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(streamFrom(`event: item.completed\nid: 1\ndata: ${envelope('event-1', '1', 'first')}\n\n`), { headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(streamFrom([
        `event: item.completed\nid: 1\ndata: ${envelope('event-1', '1', 'first')}\n\n`,
        `event: item.completed\nid: 2\ndata: ${envelope('event-2', '2', 'second')}\n\n`,
      ].join('')), { headers: { 'Content-Type': 'text/event-stream' } }))

    await streamAgentSessionEvents({
      sessionId: 'session-1', fetcher, signal: controller.signal, retryDelayMs: 0,
      onEvent: event => { events.push({ id: event.id, body: event.body }); if (event.id === 'event-2') controller.abort() },
    })

    expect(events).toEqual([{ id: 'event-1', body: 'first' }, { id: 'event-2', body: 'second' }])
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
      '/api/agent/sessions/session-1/events',
      '/api/agent/sessions/session-1/events?afterSequence=1',
    ])
  })
})
