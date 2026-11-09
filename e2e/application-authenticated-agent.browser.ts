// This uses real Web/Worker/database paths with a synthetic model and a seeded
// application/task link; it does not test approval, submission or a receipt.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const origin = 'http://127.0.0.1:3100'
const goal = 'Fixture native question round'
const question = 'Which synthetic city should the fixture use?'
const answer = 'Fixture Dublin'
const finalText = 'Synthetic question was answered and the canonical turn resumed.'

function installFinalDiagnostics(target: { sessionId: string; turnId: string }) {
  const cap = 9
  const counts = { terminalFrameCount: 0, terminalFrameCountCapped: false, targetTerminalCount: 0, targetTerminalCountCapped: false }
  let firstSessionTerminal: Record<string, boolean> | null = null
  let firstTargetTerminal: Record<string, boolean> | null = null
  let finalItemTarget: Record<string, boolean> | null = null
  let finalHydration: Record<string, boolean | string> | null = null
  const addCount = (key: 'terminalFrameCount' | 'targetTerminalCount', cappedKey: 'terminalFrameCountCapped' | 'targetTerminalCountCapped') => {
    if (counts[key] < cap) counts[key]++
    else counts[cappedKey] = true
  }
  const copyTurn = (summary: Record<string, unknown>) => ({
    eventNameMatches: summary.eventNameMatches === true, rawTypeMatches: summary.rawTypeMatches === true,
    rawSessionMatches: summary.rawSessionMatches === true, rawTurnMatches: summary.rawTurnMatches === true,
    rawActorMatches: summary.rawActorMatches === true, rawPayloadRecord: summary.rawPayloadRecord === true,
    rawPayloadTurnMatches: summary.rawPayloadTurnMatches === true, rawFinalItemMatchesEventItem: summary.rawFinalItemMatchesEventItem === true,
    normalized: summary.normalized === true, normalizedSessionMatches: summary.normalizedSessionMatches === true,
    normalizedTurnMatches: summary.normalizedTurnMatches === true,
  })
  const copyTarget = (summary: Record<string, unknown>) => ({
    targetSessionMatches: summary.targetSessionMatches === true, targetTurnMatches: summary.targetTurnMatches === true,
    actorMatches: summary.actorMatches === true, sequencePresent: summary.sequencePresent === true,
    itemPresent: summary.itemPresent === true, payloadRecord: summary.payloadRecord === true,
    payloadTurnMatches: summary.payloadTurnMatches === true, payloadTaskMatches: summary.payloadTaskMatches === true,
    finalItemMatchesEventItem: summary.finalItemMatchesEventItem === true, targetAccepted: summary.targetAccepted === true,
  })
  const copyHydration = (summary: Record<string, unknown>) => ({
    requestStarted: summary.requestStarted === true, responseReceived: summary.responseReceived === true,
    responseCategory: summary.responseCategory === 'ok' || summary.responseCategory === 'non_ok' ? summary.responseCategory : 'unavailable',
    jsonParsed: summary.jsonParsed === true,
    itemCountCategory: summary.itemCountCategory === 'zero' || summary.itemCountCategory === 'one' || summary.itemCountCategory === 'many'
      ? summary.itemCountCategory : 'unavailable',
    itemAccepted: summary.itemAccepted === true, projectionAccepted: summary.projectionAccepted === true,
    replayDispatched: summary.replayDispatched === true,
  })
  const diagnostics = {
    matchesTarget: (sessionId: unknown, turnId: unknown) => sessionId === target.sessionId && turnId === target.turnId,
    recordTurnCompleted(summary: Record<string, unknown>) {
      addCount('terminalFrameCount', 'terminalFrameCountCapped')
      if (summary.rawSessionMatches === true && firstSessionTerminal === null) firstSessionTerminal = copyTurn(summary)
      if (summary.rawSessionMatches === true && summary.rawTurnMatches === true) {
        addCount('targetTerminalCount', 'targetTerminalCountCapped')
        if (firstTargetTerminal === null) firstTargetTerminal = copyTurn(summary)
      }
    },
    recordFinalItemTarget(summary: Record<string, unknown>) { if (finalItemTarget === null) finalItemTarget = copyTarget(summary) },
    recordFinalItemHydration(summary: Record<string, unknown>) { if (finalHydration === null) finalHydration = copyHydration(summary) },
    snapshot() {
      return { ...counts, firstSessionTerminal, firstTargetTerminal, finalItemTarget, finalHydration }
    },
  }
  Object.defineProperty(window, '__applymateFinalDiagnostics', { configurable: true, value: diagnostics })
}

test('synthetic native question resumes the actual authenticated turn', async ({ browser }) => {
  if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
    || process.env.APPLICATION_AUTH_AGENT_REVIEWED_EXECUTION !== 'true'
    || process.env.DATABASE_URL !== 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
    || process.env.DIRECT_URL !== process.env.DATABASE_URL || process.env.RLS_RUNTIME_MODE !== 'off'
    || process.env.REDIS_URL !== 'redis://redis:6379/15' || process.env.PLATFORM_ENV !== 'development'
    || process.env.AGENT_WEB_URL !== origin || process.env.AGENT_WORKER_SECRET !== 'fixture-only-worker-secret-at-least-32-bytes') throw new Error('Not the reviewed disposable fixture')

  const context = await browser.newContext({ baseURL: origin })
  const applicationMutations: string[] = []
  type StatusCategory = '2xx' | '3xx' | '4xx' | '5xx' | 'unavailable'
  type StreamObservation = { status: StatusCategory; eventStream: boolean | null }
  type TimelineObservation = {
    requestMatchesFinalItem: boolean; requestIsGet: boolean; status: StatusCategory; itemCount: number | null; itemCountCapped: boolean
    returnedSessionBound: boolean | null; returnedTurnBound: boolean | null; returnedItemBoundToRequest: boolean | null
    returnedTypeIsAgentMessage: boolean | null; returnedStatusIsCompleted: boolean | null; returnedPhaseIsFinalAnswer: boolean | null
    textMatches: boolean | null; responseJsonParsed: boolean
  }
  const statusCategory = (status: number | null): StatusCategory => status === null ? 'unavailable'
    : status < 300 ? '2xx' : status < 400 ? '3xx' : status < 500 ? '4xx' : '5xx'
  const observationLimit = 9
  const streamObservations: StreamObservation[] = []
  const timelineObservations: TimelineObservation[] = []
  const streamRequests = new WeakMap<Request, StreamObservation>()
  const timelineRequests = new WeakMap<Request, TimelineObservation>()
  const timelineRequestMatchesItem = new WeakMap<TimelineObservation, (itemId: string) => boolean>()
  let diagnosticTargetSessionId: string | null = null
  let diagnosticTargetTurnId: string | null = null
  let diagnosticFinalItemId: string | null = null
  let firstFinalItemTimelineObservation: TimelineObservation | null = null
  let firstUnboundedTimelineObservation: TimelineObservation | null = null
  let streamRequestCount = 0, streamRequestCountCapped = false
  let timelineRequestCount = 0, timelineRequestCountCapped = false
  context.on('request', request => {
    let url: URL
    try { url = new URL(request.url()) } catch { return }
    if (url.origin !== origin || request.method() !== 'GET') return
    const eventPath = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/events$/)
    const timelinePath = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/timeline$/)
    const path = eventPath ?? timelinePath
    if (!path) return
    let sessionId: string
    try { sessionId = decodeURIComponent(path[1]) } catch { return }
    if (sessionId !== diagnosticTargetSessionId) return
    if (eventPath) {
      if (streamRequestCount < observationLimit) streamRequestCount++
      else streamRequestCountCapped = true
      if (streamObservations.length < observationLimit) {
        const observation: StreamObservation = { status: 'unavailable', eventStream: null }
        streamObservations.push(observation)
        streamRequests.set(request, observation)
      }
    }
    const requestItemId = url.searchParams.get('itemId')
    if (!timelinePath || !requestItemId) return
    if (timelineRequestCount < observationLimit) timelineRequestCount++
    else timelineRequestCountCapped = true
    const boundedSlotAvailable = timelineObservations.length < observationLimit
    const isFirstFinalItemRequest = requestItemId === diagnosticFinalItemId && firstFinalItemTimelineObservation === null
    const isFirstOverflowCandidate = !boundedSlotAvailable && firstUnboundedTimelineObservation === null
    if (boundedSlotAvailable || isFirstFinalItemRequest || isFirstOverflowCandidate) {
      const observation: TimelineObservation = { requestMatchesFinalItem: isFirstFinalItemRequest, requestIsGet: true, status: 'unavailable',
        itemCount: null, itemCountCapped: false, returnedSessionBound: null, returnedTurnBound: null, returnedItemBoundToRequest: null,
        returnedTypeIsAgentMessage: null, returnedStatusIsCompleted: null, returnedPhaseIsFinalAnswer: null, textMatches: null, responseJsonParsed: false }
      if (boundedSlotAvailable) timelineObservations.push(observation)
      if (isFirstFinalItemRequest) firstFinalItemTimelineObservation = observation
      if (isFirstOverflowCandidate) firstUnboundedTimelineObservation = observation
      timelineRequestMatchesItem.set(observation, finalItemId => requestItemId === finalItemId)
      timelineRequests.set(request, observation)
    }
  })
  context.on('response', response => {
    const request = response.request()
    const stream = streamRequests.get(request)
    if (stream) {
      stream.status = statusCategory(response.status())
      stream.eventStream = response.headers()['content-type']?.toLowerCase().includes('text/event-stream') === true
    }
    const timeline = timelineRequests.get(request)
    if (!timeline) return
    timeline.status = statusCategory(response.status())
    void response.json().then(body => {
      const items = body && typeof body === 'object' && Array.isArray((body as { items?: unknown[] }).items)
        ? (body as { items: unknown[] }).items : []
      timeline.itemCount = Math.min(items.length, observationLimit)
      timeline.itemCountCapped = items.length > observationLimit
      const item = items.length === 1 && items[0] && typeof items[0] === 'object' ? items[0] as Record<string, unknown> : null
      const content = item?.content && typeof item.content === 'object' ? item.content as Record<string, unknown> : null
      timeline.returnedSessionBound = typeof item?.sessionId === 'string' && item.sessionId === diagnosticTargetSessionId
      timeline.returnedTurnBound = typeof item?.turnId === 'string' && item.turnId === diagnosticTargetTurnId
      timeline.returnedItemBoundToRequest = typeof item?.id === 'string' && timelineRequestMatchesItem.get(timeline)?.(item.id) === true
      timeline.returnedTypeIsAgentMessage = item?.type === 'agent_message'
      timeline.returnedStatusIsCompleted = item?.status === 'completed'
      timeline.returnedPhaseIsFinalAnswer = item?.phase === 'final_answer'
      timeline.textMatches = typeof content?.text === 'string' && content.text === finalText
      timeline.responseJsonParsed = true
    }, () => { timeline.responseJsonParsed = false })
  })
  // Context request events observe browser traffic, not page.request calls
  // such as session creation or the message that starts the Turn.
  context.on('request', request => {
    const pathname = new URL(request.url()).pathname
    if (request.method() !== 'GET' && (pathname === '/api/jobs/fixture-question-job/apply'
      || pathname === '/api/auto-apply' || pathname === '/api/agent/application-tasks')) applicationMutations.push(pathname)
  })
  const requireFixture = createRequire(path.resolve('e2e/application-authenticated-agent.browser.ts'))
  const { initializeFixtureSse, attachFixtureApplication, inspectFixtureApplication, inspectTurn, closeFixtureDb } = requireFixture('./application-authenticated-agent-db.cjs') as {
    initializeFixtureSse: () => Promise<void>
    attachFixtureApplication: (sessionId: string, turnId: string) => Promise<void>
    inspectFixtureApplication: (sessionId: string) => Promise<{ jobStatus: string; taskStatus: string; sessionId: string; email: string }>
    inspectTurn: (sessionId: string, turnId: string, expectedFinalText: string, expectedQuestionAnswer: string, includeQuestionDetails?: boolean) => Promise<{ turn: { status: string; completedEvents: number; completedEventsCapped: boolean; answeredEvents: number; answeredEventsCapped: boolean; finalResponsePresent: boolean; finalResponseMatches: boolean; errorPresent: boolean }; questionCount: number; questionCountCapped: boolean; questions: { id?: string; status: string; content?: { questionId?: string; question?: string; answer?: string | null; toolCallId?: string } }[]; questionAnswerMatches: boolean; finalItemCount: number; finalItemCountCapped: boolean; finalItems: { type: string; status: string; phase: string | null; textMatches: boolean }[]; eventCount: number; eventCountCapped: boolean; terminalEventCount: number; terminalEventCountCapped: boolean; terminalEvents: { finalItemPresent: boolean; finalItemMatchesPersisted: boolean; eventItemBound: boolean }[]; eventTypes: string[]; stepCount: number; stepCountCapped: boolean; steps: { status: string }[]; taskCount: number; taskCountCapped: boolean; tasks: { status: string }[]; toolResultCount: number; toolResultCountCapped: boolean; toolResultQuestionRedacted: boolean | null }>
    closeFixtureDb: () => Promise<void>
  }
  try {
    await initializeFixtureSse()
    // All page requests outside the local Web origin fail. Docker internal
    // networking must be independently verified by the caller for all processes.
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.goto('/login')
    await page.getByPlaceholder('you@example.com').fill('candidate-a@example.invalid')
    await page.locator('input[type="password"]').fill('Fixture-only-password-123')
    await page.getByRole('button', { name: /^(Sign in|Log in)$/ }).click()
    await page.waitForURL(url => url.origin === origin && url.pathname === '/')
    const authenticated = await page.request.get('/api/auth/session')
    expect((await authenticated.json()).user.email).toBe('candidate-a@example.invalid')

    const created = await page.request.post('/api/agent/sessions', { data: { goal } })
    // Keep a creation failure visible, but inspect the single already-persisted
    // session to independently exercise the downstream question path. Never
    // repeat this POST: a 500 can occur after the database write.
    expect.soft(created.status(), 'Session creation must return 201; a 500 may already have persisted it').toBe(201)
    let sessionId: string
    if (created.status() === 201) {
      sessionId = (await created.json()).session.id as string
    } else {
      expect(created.status()).toBe(500)
      const listed = await page.request.get('/api/agent/sessions')
      expect(listed.status()).toBe(200)
      const sessions = (await listed.json()).sessions as { id: string; goal: string; source: string; status: string }[]
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ goal, source: 'chat', status: 'running' })
      sessionId = sessions[0].id
    }
    expect(sessionId).toBeTruthy()
    diagnosticTargetSessionId = sessionId
    const sent = await page.request.post(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, { data: {
      clientMessageId: `fixture-question-${randomUUID()}`, content: [{ type: 'text', text: goal }],
    } })
    expect(sent.status()).toBe(202)
    const turnId = (await sent.json()).turnId as string
    expect(turnId).toBeTruthy()
    diagnosticTargetTurnId = turnId
    await context.addInitScript(installFinalDiagnostics, { sessionId, turnId })
    await page.evaluate(installFinalDiagnostics, { sessionId, turnId })
    const turnsUrl = `/api/agent/sessions/${encodeURIComponent(sessionId)}/turns`
    try {
      await expect.poll(async () => {
        const response = await page.request.get(turnsUrl)
        if (!response.ok()) return `http:${response.status()}`
        const body = await response.json()
        if (body.projection.activeTurn?.id === turnId) return body.projection.activeTurn.status
        const target = body.turns.find((turn: { id: string }) => turn.id === turnId)
        return `not-active:${target?.status ?? 'missing'}`
      }, { timeout: 60_000 }).toBe('waiting_for_user')
    } catch (error) {
      const diagnostic = await inspectTurn(sessionId, turnId, finalText, answer)
      console.error('Synthetic turn diagnostic', JSON.stringify({ status: diagnostic.turn.status,
        questionCount: diagnostic.questionCount, questionCountCapped: diagnostic.questionCountCapped,
        eventCount: diagnostic.eventCount, eventCountCapped: diagnostic.eventCountCapped, eventTypes: diagnostic.eventTypes,
        toolResultCount: diagnostic.toolResultCount, toolResultCountCapped: diagnostic.toolResultCountCapped,
        toolResultQuestionRedacted: diagnostic.toolResultQuestionRedacted,
        stepCount: diagnostic.stepCount, stepCountCapped: diagnostic.stepCountCapped, steps: diagnostic.steps.map(step => ({ status: step.status })),
        taskCount: diagnostic.taskCount, taskCountCapped: diagnostic.taskCountCapped, tasks: diagnostic.tasks.map(task => ({ status: task.status })) }))
      throw error
    }
    const waiting = await inspectTurn(sessionId, turnId, finalText, answer, true)
    expect(waiting.turn.status).toBe('waiting_for_user')
    expect(waiting.questions).toHaveLength(1)
    expect(waiting.questions[0].status).toBe('started')
    expect(waiting.questions[0].content!).toMatchObject({ question, toolCallId: 'fixture-native-question', answer: null })
    expect(waiting.questions[0].content!.questionId).toBeTruthy()
    const questionPath = `/api/agent/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(waiting.questions[0].content!.questionId!)}`
    let questionPosts = 0
    context.on('request', request => {
      const url = new URL(request.url())
      if (request.method() === 'POST' && url.origin === origin && url.pathname === questionPath) questionPosts++
    })

    // The task link is fixture data, attached only after the real Turn has
    // reached its real question. It is not a claim that application execution
    // generated the question or that any employer submission took place.
    await attachFixtureApplication(sessionId, turnId)
    expect(await inspectFixtureApplication(sessionId)).toMatchObject({ jobStatus: 'saved', taskStatus: 'waiting_for_user', sessionId })
    const taskResponse = await page.request.get('/api/agent/application-tasks')
    expect(taskResponse.status()).toBe(200)
    expect((await taskResponse.json()).tasks).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'fixture-question-task', jobId: 'fixture-question-job', sessionId, status: 'waiting_for_user',
    })]))
    await page.goto('/?page=jobs')
    await page.getByRole('button', { name: /Needs your attention|需要我处理/ }).click()
    const attention = page.getByRole('region', { name: /Needs your attention|需要我处理/ })
    await expect(attention).toContainText('Fixture Question Company · Fixture Question Engineer')
    await attention.getByRole('link', { name: /View this application|查看此申请/ }).click()
    await expect(page).toHaveURL(/highlight=fixture-question-job/)
    const drawer = page.getByRole('dialog')
    await expect(drawer).toContainText('Fixture Question Engineer')
    await expect(drawer).toContainText('Fixture Question Company')
    const eventResponse = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/agent/sessions/${encodeURIComponent(sessionId)}/events`)
    await drawer.getByRole('link', { name: /Continue in the original task|进入原任务处理/ }).click()
    await expect(page).toHaveURL(/page=agent/)
    await expect(page).toHaveURL(new RegExp(`sessionId=${encodeURIComponent(sessionId)}`))
    const stream = await eventResponse
    expect(stream.status()).toBe(200)
    expect(stream.headers()['content-type']).toContain('text/event-stream')
    const detailsToggle = page.getByRole('button', { name: /^(Tasks & results|任务与结果)/ })
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'false')
    await detailsToggle.click()
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true')
    const card = page.locator('[data-agent-question-card="true"]')
    await expect(card.getByText(question, { exact: true })).toBeVisible({ timeout: 30_000 })
    await card.getByRole('textbox', { name: question }).fill(answer)
    const submitted = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).origin === origin && new URL(response.url()).pathname === questionPath)
    await card.getByRole('button', { name: /^(Send answer|发送回答)$/ }).click()
    const answered = await submitted
    expect(answered.status()).toBe(202)
    expect((await answered.json()).disposition).toBe('resolved')
    await expect.poll(async () => {
      const response = await page.request.get(turnsUrl)
      if (!response.ok()) return 'unavailable'
      const body = await response.json()
      const target = body.turns.find((turn: { id: string }) => turn.id === turnId) as { status: string; finalItemId?: string | null } | undefined
      if (target?.status === 'completed' && typeof target.finalItemId === 'string' && diagnosticFinalItemId === null) {
        diagnosticFinalItemId = target.finalItemId
        const candidates = [...timelineObservations, ...(firstUnboundedTimelineObservation ? [firstUnboundedTimelineObservation] : [])]
        firstFinalItemTimelineObservation = candidates.find(request => timelineRequestMatchesItem.get(request)?.(diagnosticFinalItemId!) === true) ?? null
        if (firstFinalItemTimelineObservation) firstFinalItemTimelineObservation.requestMatchesFinalItem = true
      }
      return target?.status ?? 'missing'
    }, { timeout: 60_000 }).toBe('completed')
    try {
      await expect(page.getByText(finalText, { exact: false })).toBeVisible({ timeout: 30_000 })
    } catch (error) {
      try {
        const snapshot = await inspectTurn(sessionId, turnId, finalText, answer)
        const persistedFinalItem = snapshot.finalItems[0] ?? null
        const persistedTerminalEvent = snapshot.terminalEvents[0] ?? null
        const firstStream = streamObservations[0]
        const firstTimeline = timelineObservations[0]
        const firstFinalItemTimeline = firstFinalItemTimelineObservation
        const domDiagnostic = await page.evaluate(({ expectedFinalItemId, expectedText }) => {
          const root = document.querySelector('[data-agent-harness-timeline="true"]')
          const projectedCount = root?.getAttribute('data-agent-completed-final-answer-count') ?? null
          const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-agent-harness-item]'))
          const finalNode = expectedFinalItemId ? nodes.find(node => node.dataset.agentHarnessItem === expectedFinalItemId) : undefined
          const box = finalNode?.getBoundingClientRect()
          const style = finalNode ? getComputedStyle(finalNode) : null
          const visible = Boolean(finalNode && box && box.width > 0 && box.height > 0 && style?.display !== 'none'
            && style?.visibility !== 'hidden' && style?.opacity !== '0')
          return {
            timelineRootPresent: Boolean(root),
            reducerProjectedFinalAnswerCount: projectedCount !== null && /^\d{1,2}$/.test(projectedCount) ? Math.min(9, Number(projectedCount)) : null,
            canonicalItemDomFound: Boolean(finalNode),
            canonicalItemTypeMatches: finalNode?.dataset.agentItemType === 'agent_message',
            canonicalItemPhaseMatches: finalNode?.dataset.agentPhase === 'final',
            canonicalItemVisible: visible,
            canonicalItemTextMatches: Boolean(finalNode && (finalNode.innerText || finalNode.textContent || '').includes(expectedText)),
          }
        }, { expectedFinalItemId: diagnosticFinalItemId, expectedText: finalText })
        const clientBoundaryDiagnostic = await page.evaluate(() => {
          const diagnostics = (window as Window & { __applymateFinalDiagnostics?: { snapshot?: () => unknown } }).__applymateFinalDiagnostics
          return diagnostics?.snapshot?.() ?? null
        })
        console.error('Synthetic final response diagnostic', JSON.stringify({
          turnCompleted: snapshot.turn.status === 'completed',
          completedEventCount: snapshot.turn.completedEvents,
          completedEventCountCapped: snapshot.turn.completedEventsCapped,
          completedEventExactlyOne: snapshot.turn.completedEvents === 1,
          answeredEventCount: snapshot.turn.answeredEvents,
          answeredEventCountCapped: snapshot.turn.answeredEventsCapped,
          answeredEventExactlyOne: snapshot.turn.answeredEvents === 1,
          finalResponsePresent: snapshot.turn.finalResponsePresent,
          finalResponseMatches: snapshot.turn.finalResponseMatches,
          persistedFinalItemCount: snapshot.finalItemCount,
          persistedFinalItemCountCapped: snapshot.finalItemCountCapped,
          persistedFinalItemType: persistedFinalItem?.type ?? null,
          persistedFinalItemStatus: persistedFinalItem?.status ?? null,
          persistedFinalItemPhase: persistedFinalItem?.phase ?? null,
          persistedFinalItemStoredTextMatches: persistedFinalItem?.textMatches ?? false,
          persistedTerminalEventCount: snapshot.terminalEventCount,
          persistedTerminalEventCountCapped: snapshot.terminalEventCountCapped,
          persistedTurnCompletedFinalItemPresent: persistedTerminalEvent?.finalItemPresent ?? false,
          persistedFinalItemMatchesTurnEvent: persistedTerminalEvent?.finalItemMatchesPersisted ?? false,
          persistedTurnEventItemBound: persistedTerminalEvent?.eventItemBound ?? false,
          questionCount: snapshot.questionCount,
          questionCountCapped: snapshot.questionCountCapped,
          questionCompleted: snapshot.questionCount === 1 && snapshot.questions[0]?.status === 'completed',
          answerMatches: snapshot.questionAnswerMatches,
          eventCount: snapshot.eventCount,
          eventCountCapped: snapshot.eventCountCapped,
          stepCount: snapshot.stepCount,
          stepCountCapped: snapshot.stepCountCapped,
          taskCount: snapshot.taskCount,
          taskCountCapped: snapshot.taskCountCapped,
          toolResultCount: snapshot.toolResultCount,
          toolResultCountCapped: snapshot.toolResultCountCapped,
          eventStreamRequestCount: streamRequestCount,
          eventStreamRequestCountCapped: streamRequestCountCapped,
          firstEventStreamStatus: firstStream?.status ?? null,
          firstEventStreamIsSse: firstStream?.eventStream ?? null,
          firstEventStreamSessionBound: Boolean(firstStream),
          targetedTimelineRequestCount: timelineRequestCount,
          targetedTimelineRequestCountCapped: timelineRequestCountCapped,
          firstTargetedTimelineRequestMatchesPersisted: firstTimeline?.requestMatchesFinalItem ?? false,
          firstTargetedTimelineStatus: firstTimeline?.status ?? null,
          firstFinalItemTimelineRequestSeen: Boolean(firstFinalItemTimeline),
          firstFinalItemTimelineRequestIsGet: firstFinalItemTimeline?.requestIsGet ?? false,
          firstFinalItemTimelineStatus: firstFinalItemTimeline?.status ?? null,
          firstFinalItemTimelineResponseJsonParsed: firstFinalItemTimeline?.responseJsonParsed ?? false,
          firstFinalItemTimelineItemCount: firstFinalItemTimeline?.itemCount ?? null,
          firstFinalItemTimelineItemCountCapped: firstFinalItemTimeline?.itemCountCapped ?? false,
          firstFinalItemTimelineSessionBound: firstFinalItemTimeline?.returnedSessionBound ?? false,
          firstFinalItemTimelineTurnBound: firstFinalItemTimeline?.returnedTurnBound ?? false,
          firstFinalItemTimelineItemBound: firstFinalItemTimeline?.returnedItemBoundToRequest ?? false,
          firstFinalItemTimelineTypeIsAgentMessage: firstFinalItemTimeline?.returnedTypeIsAgentMessage ?? false,
          firstFinalItemTimelineStatusIsCompleted: firstFinalItemTimeline?.returnedStatusIsCompleted ?? false,
          firstFinalItemTimelinePhaseIsFinalAnswer: firstFinalItemTimeline?.returnedPhaseIsFinalAnswer ?? false,
          firstFinalItemTimelineTextMatches: firstFinalItemTimeline?.textMatches === true,
          clientBoundary: clientBoundaryDiagnostic,
          ...domDiagnostic,
        }))
      } catch {
        console.error('Synthetic final response diagnostic unavailable')
      }
      throw error
    }
    const finished = await inspectTurn(sessionId, turnId, finalText, answer, true)
    expect(finished.turn).toMatchObject({ status: 'completed', completedEvents: 1, answeredEvents: 1 })
    expect(finished.turn.finalResponseMatches).toBe(true)
    expect(finished.questions).toHaveLength(1)
    expect(finished.questions[0]).toMatchObject({ status: 'completed', content: { question, answer } })
    // The synthetic link is not an application execution or a result receipt.
    expect(await inspectFixtureApplication(sessionId)).toMatchObject({ jobStatus: 'saved', sessionId })
    expect(applicationMutations).toEqual([])

    const other = await browser.newContext({ baseURL: origin })
    try {
      await other.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      const otherPage = await other.newPage()
      await otherPage.goto('/login')
      await otherPage.getByPlaceholder('you@example.com').fill('candidate-b@example.invalid')
      await otherPage.locator('input[type="password"]').fill('Fixture-only-password-123')
      await otherPage.getByRole('button', { name: /^(Sign in|Log in)$/ }).click()
      await otherPage.waitForURL(url => url.origin === origin && url.pathname === '/')
      expect((await otherPage.request.get(turnsUrl)).status()).toBe(404)
      expect((await otherPage.request.get('/api/jobs/fixture-question-job')).status()).toBe(404)
    } finally { await other.close() }
    expect(questionPosts).toBe(1)
  } finally { await context.close(); await closeFixtureDb() }
})
