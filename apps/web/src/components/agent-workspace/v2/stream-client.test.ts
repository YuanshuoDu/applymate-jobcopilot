import { describe, expect, it, vi } from 'vitest'

import { createTimelineState, selectTimelineItems, timelineReducer, type TimelineAction, type TimelineState } from './timeline-reducer'
import { hydrateTimeline, streamAgentTimeline } from './stream-client'
import { redactStreamEventPayload } from '../../../lib/agent/session/stream-redaction'
import { TASK_GRAPH_SOURCES_SCHEMA_VERSION } from '../../../lib/agent/session/final-task-graph-source-manifest'
import { canonicalTaskGraphSourceKey } from '../../../lib/agent/session/final-task-graph-source-detail'

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
      blockedBy: { kind: null, ids: [] }, goalRevision: null, planRevision: null,
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

function approvalRequestedEvent(sequence = '3') {
  return {
    schemaVersion: 'agent-harness.v2', id: `approval-requested-${sequence}`, sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null,
    type: 'approval.requested', actor: 'orchestrator', sequence,
    payload: { approvalId: 'wait-1', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2 },
  }
}

function approvalResolvedEvent(sequence = '4') {
  return {
    schemaVersion: 'agent-harness.v2', id: `approval-resolved-${sequence}`, sessionId: 'session-1', turnId: 'turn-1', itemId: 'wait-item-1', taskId: null,
    type: 'approval.resolved', actor: 'user', sequence,
    payload: { waitKind: 'approval', waitId: 'wait-1', itemId: 'wait-item-1', turnId: 'turn-1', toolCallId: 'call-1', status: 'approved', nextTurnRevision: 3, answerAvailable: false },
  }
}

function questionStubEvent(sequence: string, questionId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2', id: `question-started-${sequence}`, sessionId: 'session-1', turnId: 'turn-1',
    itemId: `question-item-${questionId}`, taskId: null, type: 'item.started', actor: 'orchestrator', sequence,
    payload: { itemId: `question-item-${questionId}`, waitKind: 'question', questionId, toolCallId: null }, ...overrides,
  }
}

function questionCanonicalItem(questionId: string, status: 'started' | 'completed' = 'started') {
  return {
    schemaVersion: 'agent-harness.v2', id: `question-item-${questionId}`, sessionId: 'session-1', turnId: 'turn-1',
    stepId: null, taskId: null, type: 'question', status, phase: 'commentary', revision: 0,
    content: {
      waitKind: 'question', questionId, stage: 'profile', question: `Choose ${questionId}?`,
      options: [{ value: 'yes', label: 'Yes' }], pending: status === 'started', answerAvailable: status === 'completed',
    },
    startedAt: '2026-09-15T00:00:00.000Z', completedAt: status === 'completed' ? '2026-09-15T00:00:01.000Z' : null,
    createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:01.000Z',
  }
}

function questionAnsweredEvent(sequence: string, questionId: string) {
  return {
    schemaVersion: 'agent-harness.v2', id: `question-answered-${sequence}`, sessionId: 'session-1', turnId: 'turn-1',
    itemId: `question-item-${questionId}`, taskId: null, type: 'question.answered', actor: 'user', sequence,
    correlationId: questionId, causationId: `question-item-${questionId}`, idempotencyKey: `answer-${questionId}`,
    payload: {
      waitKind: 'question', waitId: questionId, itemId: `question-item-${questionId}`, turnId: 'turn-1',
      toolCallId: null, status: 'answered', nextTurnRevision: 1, answerAvailable: true,
    },
  }
}

function sseEvent(value: unknown, type = 'item.started') {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const FINAL_ITEM_ID = 'turn:turn-1:item:final:step-1'

function finalMessageDto(overrides: Record<string, unknown> = {}) {
  return {
    ...item(FINAL_ITEM_ID, 1), taskId: 'root-task', stepId: 'step-1', status: 'completed', phase: 'final_answer',
    content: { text: 'The final response stays unchanged.', summary: 'A short supported summary.' }, ...overrides,
  }
}

type TestStreamEnvelope = {
  schemaVersion: string
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  type: string
  actor: string
  sequence: string
  payload: unknown
}

function redactedEnvelope(event: TestStreamEnvelope): TestStreamEnvelope {
  return {
    ...event,
    payload: redactStreamEventPayload(event.type, event.payload, {
      sessionId: event.sessionId, turnId: event.turnId, itemId: event.itemId, taskId: event.taskId,
    }),
  }
}

function finalMessageDtoWithoutSchemaVersion(): Record<string, unknown> {
  const dto: Record<string, unknown> = finalMessageDto()
  delete dto.schemaVersion
  return dto
}

function finalCompletionFrames(includeOverflow = false, finalContent?: unknown) {
  const overflow = includeOverflow ? sseEvent({
    schemaVersion: 'agent-harness.v2', id: 'overflow-before-final', sessionId: 'session-1', turnId: 'turn-1',
    itemId: null, taskId: null, type: 'stream.overflow', actor: 'system', sequence: null, payload: { snapshotRequired: true },
  }, 'stream.overflow') : ''
  const started = redactedEnvelope({ schemaVersion: 'agent-harness.v2', id: 'final-start', sessionId: 'session-1', turnId: 'turn-1', itemId: FINAL_ITEM_ID,
    taskId: 'root-task', type: 'item.started', actor: 'orchestrator', sequence: '1',
    payload: { item: finalMessageDto({ status: 'started', content: { text: 'PRIVATE_FINAL_RESPONSE' } }) } })
  const completed = redactedEnvelope({ schemaVersion: 'agent-harness.v2', id: 'final-completed', sessionId: 'session-1', turnId: 'turn-1', itemId: FINAL_ITEM_ID,
    taskId: 'root-task', type: 'item.completed', actor: 'orchestrator', sequence: '2',
    payload: finalContent
      ? { itemId: FINAL_ITEM_ID, status: 'completed', content: finalContent }
      : { item: finalMessageDto({ content: { text: 'PRIVATE_FINAL_RESPONSE' } }) } })
  const turnCompleted = redactedEnvelope({ schemaVersion: 'agent-harness.v2', id: 'turn-completed', sessionId: 'session-1', turnId: 'turn-1', itemId: FINAL_ITEM_ID,
    taskId: 'root-task', type: 'turn.completed', actor: 'orchestrator', sequence: '3',
    payload: { turnId: 'turn-1', taskId: 'root-task', finalItemId: FINAL_ITEM_ID, usage: { inputTokens: 3, outputTokens: 2 } } })
  if (!finalContent) expect(isRecord(completed.payload) && isRecord(completed.payload.item) ? completed.payload.item.content : null).toBe('[REDACTED]')
  expect(isRecord(turnCompleted.payload) ? turnCompleted.payload.finalItemId : null).toBe(FINAL_ITEM_ID)
  return [overflow, sseEvent(started, 'item.started'), sseEvent(completed, 'item.completed'), sseEvent(turnCompleted, 'turn.completed')].join('')
}

async function runFinalItemStream(items: unknown[], requireSnapshot = false, finalContent?: unknown) {
  const controller = new AbortController()
  let state: TimelineState = createTimelineState('session-1')
  let redactedContent: unknown
  let finalReplayCount = 0
  const dispatch = (action: TimelineAction) => {
    state = timelineReducer(state, action)
    if (action.type === 'replay' && action.items.some(value => isRecord(value) && value.id === FINAL_ITEM_ID)) finalReplayCount++
    if (action.type === 'event' && isRecord(action.event) && action.event.type === 'item.completed') redactedContent = state.itemsById[FINAL_ITEM_ID]?.content
    if (action.type === 'replay' && state.itemsById[FINAL_ITEM_ID]?.source === 'replay') controller.abort()
    if (action.type === 'disconnected' && state.events.some(event => event.type === 'turn.completed')) controller.abort()
  }
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false } })))
    .mockResolvedValueOnce(new Response(streamFrom(finalCompletionFrames(requireSnapshot, finalContent)), { headers: { 'Content-Type': 'text/event-stream' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items })))
  await streamAgentTimeline({ sessionId: 'session-1', dispatch, fetcher, signal: controller.signal, retryDelayMs: 0 })
  return { state, redactedContent, finalReplayCount, urls: fetcher.mock.calls.map(([url]) => String(url)) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
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

    expect(state.cognitiveAgenda.latest).toMatchObject({ nextAction: 'continue_turn' })
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

  it('hydrates approval facts from the first page and ignores approval events on later pages', async () => {
    let state: TimelineState = createTimelineState('session-1')
    const dispatch = (action: TimelineAction) => { state = timelineReducer(state, action) }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      items: [], page: { hasMore: true, nextCursor: 'next' }, approvalEvents: [approvalResolvedEvent(), approvalRequestedEvent()],
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      items: [], page: { hasMore: false, nextCursor: null }, approvalEvents: [approvalRequestedEvent('8')],
    })))

    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher })

    expect(state.events.map(event => event.id)).toEqual(['approval-requested-3', 'approval-resolved-4'])
    expect(state.approvalLedger.projection.approvals[0]?.status).toBe('approved')
    expect(state.events.some(event => event.id === 'approval-requested-8')).toBe(false)
  })

  it('uses event id as the stable tie-breaker for first-page tail events', async () => {
    const dispatch = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      items: [], page: { hasMore: false, nextCursor: null }, agenda: { id: 'z-event', sequence: '7' },
      steeringMarkers: [{ id: 'a-event', sequence: '7' }],
    })))

    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher })

    expect(dispatch).toHaveBeenCalledWith({ type: 'hydrate', items: [], tail: [{ id: 'a-event', sequence: '7' }, { id: 'z-event', sequence: '7' }] })
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

  it('hydrates an ID-only question stub once and keeps its durable event metadata', async () => {
    const controller = new AbortController()
    let state: TimelineState = createTimelineState('session-1')
    let hydrateCount = 0
    const dispatch = (action: TimelineAction) => {
      state = timelineReducer(state, action)
      if (action.type === 'hydrate' && ++hydrateCount === 2) controller.abort()
    }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false } })))
      .mockResolvedValueOnce(new Response(streamFrom(sseEvent(questionStubEvent('10', 'question-1'))), { headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [questionCanonicalItem('question-1')], page: { hasMore: false } })))

    await streamAgentTimeline({ sessionId: 'session-1', dispatch, fetcher, signal: controller.signal, retryDelayMs: 0 })

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/agent/sessions/session-1/timeline?limit=100',
      '/api/agent/sessions/session-1/events',
      '/api/agent/sessions/session-1/timeline?limit=100',
    ])
    expect(state.events.map(event => event.id)).toEqual(['question-started-10'])
    expect(state.itemsById['question-item-question-1']).toMatchObject({ type: 'question', status: 'started' })
    expect(state.fallbackItems).toEqual([])
  })

  it('continues targeted question hydration past eight pages in a long session', async () => {
    const controller = new AbortController()
    let state: TimelineState = createTimelineState('session-1')
    let hydrateCount = 0
    const dispatch = (action: TimelineAction) => {
      state = timelineReducer(state, action)
      if (action.type === 'hydrate' && ++hydrateCount === 2) controller.abort()
    }
    const pages = Array.from({ length: 9 }, (_, index) => ({
      items: [index === 8 ? questionCanonicalItem('long-session') : item(`history-${index}`)],
      page: { hasMore: index < 8, nextCursor: index < 8 ? `cursor-${index + 1}` : null },
    }))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false } })))
      .mockResolvedValueOnce(new Response(streamFrom(sseEvent(questionStubEvent('10', 'long-session'))), { headers: { 'Content-Type': 'text/event-stream' } }))
    for (const page of pages) fetcher.mockResolvedValueOnce(new Response(JSON.stringify(page)))

    await streamAgentTimeline({ sessionId: 'session-1', dispatch, fetcher, signal: controller.signal, retryDelayMs: 0 })

    expect(fetcher).toHaveBeenCalledTimes(11)
    expect(fetcher.mock.calls.slice(2).map(([url]) => String(url))).toEqual([
      '/api/agent/sessions/session-1/timeline?limit=100',
      ...Array.from({ length: 8 }, (_, index) => `/api/agent/sessions/session-1/timeline?limit=100&cursor=cursor-${index + 1}`),
    ])
    expect(state.itemsById['question-item-long-session']).toMatchObject({ type: 'question', status: 'started' })
  })

  it('hydrates a completed final response directly and leaves the live reducer replay-identical', async () => {
    const safeItem = finalMessageDto()
    const live = await runFinalItemStream([safeItem])
    const replay = timelineReducer(createTimelineState('session-1'), { type: 'replay', items: [safeItem] })

    expect(live.redactedContent).toBe('[REDACTED]')
    expect(live.finalReplayCount).toBe(1)
    expect(live.state.itemsById[FINAL_ITEM_ID]).toEqual(replay.itemsById[FINAL_ITEM_ID])
    expect(live.state.itemsById[FINAL_ITEM_ID]?.content).toEqual({ text: 'The final response stays unchanged.', summary: 'A short supported summary.' })
    expect(live.urls).toEqual([
      '/api/agent/sessions/session-1/timeline?limit=100',
      '/api/agent/sessions/session-1/events',
      `/api/agent/sessions/session-1/timeline?itemId=${encodeURIComponent(FINAL_ITEM_ID)}`,
    ])
    expect(JSON.stringify(live.state.itemsById[FINAL_ITEM_ID]?.content)).not.toContain('PRIVATE')
  })

  it('accepts safe answer evidence and keeps live completion identical to timeline replay', async () => {
    const text = 'A match. [[source:S1]]'
    const answerEvidence = {
      schemaVersion: 1,
      sources: [{ key: 'S1', kind: 'job', label: 'Engineer at Example Co', excerpt: 'Dublin role.' }],
    }
    const displayContent = { text, summary: 'Good fit.', answerEvidence }
    const safeItem = finalMessageDto({ content: displayContent })
    const live = await runFinalItemStream([safeItem], false, {
      text, final: { response: text, summary: 'Good fit.', answerEvidence, evidenceRefs: ['PRIVATE_TOOL_CALL_ID'], usage: { tokens: 4 } },
    })
    const replay = timelineReducer(createTimelineState('session-1'), { type: 'replay', items: [safeItem] })

    expect(live.redactedContent).toEqual(displayContent)
    expect(live.state.itemsById[FINAL_ITEM_ID]?.content).toEqual(replay.itemsById[FINAL_ITEM_ID]?.content)
    expect(JSON.stringify(live.state.itemsById[FINAL_ITEM_ID]?.content)).not.toContain('PRIVATE_TOOL_CALL_ID')
  })

  it('preserves safe final text when invalid answer evidence is stripped during replay', async () => {
    const safeText = 'Safe text. [[source:S1]]'
    const invalidItem = finalMessageDto({
      content: {
        text: safeText,
        answerEvidence: {
          schemaVersion: 1,
          sources: [{ key: 'S1', kind: 'job', label: 'Job', excerpt: 'Safe', raw: 'PRIVATE' }],
        },
      },
    })
    const live = await runFinalItemStream([invalidItem])
    const finalItem = live.state.itemsById[FINAL_ITEM_ID]

    expect(live.finalReplayCount).toBe(1)
    expect(finalItem?.source).toBe('replay')
    expect(finalItem?.content).toEqual({ text: 'Safe text. ' })
    expect(JSON.stringify(finalItem?.content)).not.toContain('PRIVATE')
  })

  it.each([
    ['id', finalMessageDto({ id: 'other-item' })],
    ['session', finalMessageDto({ sessionId: 'session-2' })],
    ['turn', finalMessageDto({ turnId: 'turn-2' })],
    ['schema version', finalMessageDto({ schemaVersion: 'agent-harness.v1' })],
    ['missing schema version', finalMessageDtoWithoutSchemaVersion()],
    ['kind', finalMessageDto({ type: 'user_message' })],
    ['status', finalMessageDto({ status: 'started' })],
    ['purpose', finalMessageDto({ phase: 'commentary' })],
    ['private content', finalMessageDto({ content: { text: 'Safe text', summary: 'Safe summary', rawFinal: 'PRIVATE_FINAL_RESPONSE' } })],
    ['private envelope', finalMessageDto({ rawFinalResponse: 'PRIVATE_FINAL_RESPONSE' })],
    ['oversized summary', finalMessageDto({ content: { text: 'Safe text', summary: 'x'.repeat(1001) } })],
  ])('ignores a final-item response with invalid %s without paging', async (_reason, invalidItem) => {
    const live = await runFinalItemStream([invalidItem])

    expect(live.urls).toEqual([
      '/api/agent/sessions/session-1/timeline?limit=100',
      '/api/agent/sessions/session-1/events',
      `/api/agent/sessions/session-1/timeline?itemId=${encodeURIComponent(FINAL_ITEM_ID)}`,
    ])
    expect(live.finalReplayCount).toBe(0)
    expect(live.state.itemsById[FINAL_ITEM_ID]).toMatchObject({ type: 'agent_message', status: 'completed', source: 'durable' })
    expect(live.state.itemsById[FINAL_ITEM_ID]?.content).not.toHaveProperty('text')
    expect(live.state.itemsById[FINAL_ITEM_ID]?.content).not.toHaveProperty('summary')
  })

  it('retains only source manifests with keys bound to the hydrated final item', async () => {
    const source = { sourceKey: canonicalTaskGraphSourceKey(FINAL_ITEM_ID, 3, 0), nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'missing' }
    const manifest = { schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION, graphRevision: 3, sources: [source] }
    const wrongKey = { ...manifest, sources: [{ ...source, sourceKey: `src_${'A'.repeat(43)}` }] }
    const wrongFinalItemKey = { ...manifest, sources: [{ ...source, sourceKey: canonicalTaskGraphSourceKey('other-final-item', 3, 0) }] }
    for (const [sidecar, expected] of [[manifest, manifest], [wrongKey, undefined], [wrongFinalItemKey, undefined],
      [{ ...manifest, taskId: 'PRIVATE_TASK_ID' }, undefined]] as const) {
      const dispatch = vi.fn()
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ items: [finalMessageDto({
        content: { text: 'Answer remains exact.', summary: 'Safe summary.', taskGraphSources: sidecar },
      })] })))
      await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher, finalItemTarget: { itemId: FINAL_ITEM_ID, turnId: 'turn-1' } })
      const action = dispatch.mock.calls[0]?.[0]
      expect(action?.type).toBe('replay')
      if (action?.type !== 'replay') continue
      const restored = action.items[0] as { content: Record<string, unknown> }
      expect(restored.content.text).toBe('Answer remains exact.')
      expect(restored.content.taskGraphSources).toEqual(expected)
      expect(JSON.stringify(restored.content)).not.toMatch(/PRIVATE_TASK_ID/)
    }
  })

  it('coalesces question stubs received in one stream turn into one hydration', async () => {
    const controller = new AbortController()
    let state: TimelineState = createTimelineState('session-1')
    let hydrateCount = 0
    const dispatch = (action: TimelineAction) => {
      state = timelineReducer(state, action)
      if (action.type === 'hydrate' && ++hydrateCount === 2) controller.abort()
    }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], page: { hasMore: false } })))
      .mockResolvedValueOnce(new Response(streamFrom([
        sseEvent(questionStubEvent('10', 'question-1')),
        sseEvent(questionStubEvent('11', 'question-2')),
      ].join('')), { headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [questionCanonicalItem('question-1'), questionCanonicalItem('question-2')], page: { hasMore: false } })))

    await streamAgentTimeline({ sessionId: 'session-1', dispatch, fetcher, signal: controller.signal, retryDelayMs: 0 })

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(state.itemsById['question-item-question-1']).toMatchObject({ type: 'question', status: 'started' })
    expect(state.itemsById['question-item-question-2']).toMatchObject({ type: 'question', status: 'started' })
  })

  it('does not dispatch a hydration response that becomes stale after abort', async () => {
    const controller = new AbortController()
    const dispatch = vi.fn()
    const response = deferred<Response>()
    const pending = hydrateTimeline({ sessionId: 'session-1', dispatch, signal: controller.signal, fetcher: vi.fn<typeof fetch>().mockReturnValue(response.promise) })
    controller.abort()
    response.resolve(new Response(JSON.stringify({ items: [questionCanonicalItem('question-1')], page: { hasMore: false } })))

    await pending

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('filters foreign session items and tail events before dispatching hydration', async () => {
    const dispatch = vi.fn()
    const foreignItem = { ...questionCanonicalItem('question-foreign'), sessionId: 'session-2' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      items: [questionCanonicalItem('question-1'), foreignItem],
      page: { hasMore: false },
      agenda: agendaEvent({ sessionId: 'session-2' }),
    })))

    await hydrateTimeline({ sessionId: 'session-1', dispatch, fetcher })

    expect(dispatch).toHaveBeenCalledWith({ type: 'hydrate', items: [questionCanonicalItem('question-1')] })
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

  it('preserves a pending stream-resync signal while replaying the final item', async () => {
    const live = await runFinalItemStream([finalMessageDto()], true)

    expect(live.state.snapshotRequired).toBe(true)
    expect(live.finalReplayCount).toBe(1)
    expect(live.urls).toEqual([
      '/api/agent/sessions/session-1/timeline?limit=100',
      '/api/agent/sessions/session-1/events',
      '/api/agent/sessions/session-1/timeline?itemId=' + encodeURIComponent(FINAL_ITEM_ID),
    ])
  })
})
