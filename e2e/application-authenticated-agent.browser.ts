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
type AgentPageDiagnostics = Record<'completionEventDelivered' | 'completionEventTargetsExpectedSessionAndTurn'
  | 'completionEventFinalItemIdMatchesEnvelopeItemId' | 'finalItemCompletedEventDelivered' | 'finalItemHydrationRequestAttempted'
  | 'finalItemHydrationTargetsExpectedItem' | 'finalItemHydrationSessionBindingMatches' | 'finalItemHydrationTurnBindingMatches'
  | 'finalItemHydrationResponseOk' | 'finalItemHydrationTextMatchesExpected' | 'finalItemHydrationSucceeded', boolean>

test('synthetic native question resumes the actual authenticated turn', async ({ browser }) => {
  if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
    || process.env.APPLICATION_AUTH_AGENT_REVIEWED_EXECUTION !== 'true'
    || process.env.DATABASE_URL !== 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
    || process.env.DIRECT_URL !== process.env.DATABASE_URL || process.env.RLS_RUNTIME_MODE !== 'off'
    || process.env.REDIS_URL !== 'redis://redis:6379/15' || process.env.PLATFORM_ENV !== 'development'
    || process.env.AGENT_WEB_URL !== origin || process.env.AGENT_WORKER_SECRET !== 'fixture-only-worker-secret-at-least-32-bytes') throw new Error('Not the reviewed disposable fixture')

  const context = await browser.newContext({ baseURL: origin })
  const applicationMutations: string[] = []
  // Context request events observe browser traffic, not page.request calls
  // such as session creation or the message that starts the Turn.
  context.on('request', request => {
    const pathname = new URL(request.url()).pathname
    if (request.method() !== 'GET' && (pathname === '/api/jobs/fixture-question-job/apply'
      || pathname === '/api/auto-apply' || pathname === '/api/agent/application-tasks')) applicationMutations.push(pathname)
  })
  const requireFixture = createRequire(path.resolve('e2e/application-authenticated-agent.browser.ts'))
  const { initializeFixtureSse, attachFixtureApplication, inspectFixtureApplication, inspectTurn,
    installAgentPageDiagnostics, closeFixtureDb } = requireFixture('./application-authenticated-agent-db.cjs') as {
    initializeFixtureSse: () => Promise<void>
    attachFixtureApplication: (sessionId: string, turnId: string) => Promise<void>
    inspectFixtureApplication: (sessionId: string) => Promise<{ jobStatus: string; taskStatus: string; sessionId: string; email: string }>
    inspectTurn: (sessionId: string, turnId: string, expectedFinalText: string) => Promise<{ turn: { status: string; error: string | null; completedEvents: number; answeredEvents: number; finalResponse: string | null }; sessionTurnBindingMatches: boolean; questions: { id: string; status: string; content: { questionId?: string; question?: string; answer?: string | null; toolCallId?: string } }[]; eventTypes: string[]; steps: { status: string; errorCode: string | null; finishReason: string | null }[]; tasks: { status: string; failureReason: string | null }[]; finalAnswer: { exactlyOneFinalAssistantItem: boolean; finalAssistantItemCompleted: boolean; finalAssistantItemHasText: boolean; finalAssistantItemTextMatchesExpected: boolean; itemCompletedEventPersistsFinalAnswer: boolean; completionEventTargetsFinalAnswer: boolean }; toolResultCount: number; toolResultQuestionRedacted: boolean | null }>
    installAgentPageDiagnostics: () => void
    closeFixtureDb: () => Promise<void>
  }
  try {
    await initializeFixtureSse()
    // All page requests outside the local Web origin fail. Docker internal
    // networking must be independently verified by the caller for all processes.
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.addInitScript(installAgentPageDiagnostics)
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
    const sent = await page.request.post(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, { data: {
      clientMessageId: `fixture-question-${randomUUID()}`, content: [{ type: 'text', text: goal }],
    } })
    expect(sent.status()).toBe(202)
    const turnId = (await sent.json()).turnId as string
    expect(turnId).toBeTruthy()
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
      const diagnostic = await inspectTurn(sessionId, turnId, finalText)
      console.error('Synthetic turn diagnostic', JSON.stringify({
        turnWaitingForUser: diagnostic.turn.status === 'waiting_for_user',
        sessionTurnBindingMatches: diagnostic.sessionTurnBindingMatches,
        turnErrorPresent: diagnostic.turn.error !== null,
        questionPersistedExactlyOnce: diagnostic.questions.length === 1,
        questionEventPresent: diagnostic.eventTypes.includes('item.started'),
        toolResultPresent: diagnostic.toolResultCount > 0,
        toolResultQuestionRedacted: diagnostic.toolResultQuestionRedacted === true,
        stepFailed: diagnostic.steps.some(step => step.status === 'failed'),
        taskFailed: diagnostic.tasks.some(task => task.status === 'failed'),
      }))
      throw error
    }
    const waiting = await inspectTurn(sessionId, turnId, finalText)
    expect(waiting.turn.status).toBe('waiting_for_user')
    expect(waiting.questions).toHaveLength(1)
    expect(waiting.questions[0].status).toBe('started')
    expect(waiting.questions[0].content).toMatchObject({ question, toolCallId: 'fixture-native-question', answer: null })
    expect(waiting.questions[0].content.questionId).toBeTruthy()
    const questionPath = `/api/agent/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(waiting.questions[0].content.questionId!)}`
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
    await page.evaluate(({ sessionId, turnId, finalText }) => {
      const target = window as Window & { __configureAgentQuestionDiagnostics?: (session: string, turn: string, text: string) => void }
      target.__configureAgentQuestionDiagnostics?.(sessionId, turnId, finalText)
    }, { sessionId, turnId, finalText })
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
      return body.turns.find((turn: { id: string }) => turn.id === turnId)?.status ?? 'missing'
    }, { timeout: 60_000 }).toBe('completed')
    const finalAnswerVisible = () => page.evaluate(expectedText => {
      const finalItems = Array.from(document.querySelectorAll('[data-agent-item-type="agent_message"][data-agent-phase="final"]'))
      return finalItems.some(item => item.textContent?.includes(expectedText) === true)
    }, finalText)
    try {
      await expect.poll(finalAnswerVisible, { timeout: 30_000 }).toBe(true)
    } catch (error) {
      try {
        const snapshot = await inspectTurn(sessionId, turnId, finalText)
        const browserDiagnostics = await page.evaluate(expectedText => {
          const value = (window as Window & { __agentQuestionDiagnostics?: AgentPageDiagnostics }).__agentQuestionDiagnostics
          const finalItems = Array.from(document.querySelectorAll('[data-agent-item-type="agent_message"][data-agent-phase="final"]'))
          return { completionEventDelivered: value?.completionEventDelivered === true,
            completionEventTargetsExpectedSessionAndTurn: value?.completionEventTargetsExpectedSessionAndTurn === true,
            completionEventFinalItemIdMatchesEnvelopeItemId: value?.completionEventFinalItemIdMatchesEnvelopeItemId === true,
            finalItemCompletedEventDelivered: value?.finalItemCompletedEventDelivered === true,
            finalItemHydrationRequestAttempted: value?.finalItemHydrationRequestAttempted === true,
            finalItemHydrationTargetsExpectedItem: value?.finalItemHydrationTargetsExpectedItem === true,
            finalItemHydrationSessionBindingMatches: value?.finalItemHydrationSessionBindingMatches === true,
            finalItemHydrationTurnBindingMatches: value?.finalItemHydrationTurnBindingMatches === true,
            finalItemHydrationResponseOk: value?.finalItemHydrationResponseOk === true,
            finalItemHydrationTextMatchesExpected: value?.finalItemHydrationTextMatchesExpected === true,
            finalItemHydrationSucceeded: value?.finalItemHydrationSucceeded === true,
            finalAssistantItemRendered: finalItems.length > 0,
            finalAnswerRendered: finalItems.some(item => item.textContent?.includes(expectedText) === true) }
        }, finalText).catch(() => ({ completionEventDelivered: false, completionEventTargetsExpectedSessionAndTurn: false,
          finalItemCompletedEventDelivered: false, completionEventFinalItemIdMatchesEnvelopeItemId: false,
          finalItemHydrationRequestAttempted: false, finalItemHydrationTargetsExpectedItem: false,
          finalItemHydrationSessionBindingMatches: false, finalItemHydrationTurnBindingMatches: false,
          finalItemHydrationResponseOk: false, finalItemHydrationTextMatchesExpected: false,
          finalAssistantItemRendered: false,
          finalItemHydrationSucceeded: false, finalAnswerRendered: false }))
        console.error('Synthetic final response diagnostic', JSON.stringify({
          turnCompleted: snapshot.turn.status === 'completed',
          completedEventExactlyOne: snapshot.turn.completedEvents === 1,
          answeredEventExactlyOne: snapshot.turn.answeredEvents === 1,
          finalResponsePresent: snapshot.turn.finalResponse !== null,
          finalResponseMatches: snapshot.turn.finalResponse?.includes(finalText) ?? false,
          sessionTurnBindingMatches: snapshot.sessionTurnBindingMatches,
          exactlyOneFinalAssistantItem: snapshot.finalAnswer.exactlyOneFinalAssistantItem,
          finalAssistantItemCompleted: snapshot.finalAnswer.finalAssistantItemCompleted,
          finalAssistantItemHasText: snapshot.finalAnswer.finalAssistantItemHasText,
          finalAssistantItemTextMatchesExpected: snapshot.finalAnswer.finalAssistantItemTextMatchesExpected,
          itemCompletedEventPersistsFinalAnswer: snapshot.finalAnswer.itemCompletedEventPersistsFinalAnswer,
          completionEventTargetsFinalAnswer: snapshot.finalAnswer.completionEventTargetsFinalAnswer,
          ...browserDiagnostics,
          questionExactlyOne: snapshot.questions.length === 1,
          questionCompleted: snapshot.questions.length === 1 && snapshot.questions[0].status === 'completed',
          answerMatches: snapshot.questions.length === 1 && snapshot.questions[0].content.answer === answer,
        }))
      } catch {
        console.error('Synthetic final response diagnostic unavailable')
      }
      throw error
    }
    const finished = await inspectTurn(sessionId, turnId, finalText)
    expect(finished.turn).toMatchObject({ status: 'completed', completedEvents: 1, answeredEvents: 1 })
    expect(finished.sessionTurnBindingMatches).toBe(true)
    expect(finished.turn.finalResponse?.includes(finalText) ?? false).toBe(true)
    expect(finished.finalAnswer).toEqual({ exactlyOneFinalAssistantItem: true, finalAssistantItemCompleted: true,
      finalAssistantItemHasText: true, finalAssistantItemTextMatchesExpected: true,
      itemCompletedEventPersistsFinalAnswer: true, completionEventTargetsFinalAnswer: true })
    expect(finished.questions).toHaveLength(1)
    expect(finished.questions[0]?.status).toBe('completed')
    expect(finished.questions[0]?.content.question === question).toBe(true)
    expect(finished.questions[0]?.content.answer === answer).toBe(true)
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
