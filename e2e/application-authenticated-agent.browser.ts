// This uses real Web/Worker/database paths with a synthetic model; it is not
// an application, approval, external submission, or employer receipt test.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'

const origin = 'http://127.0.0.1:3100'
const goal = 'Fixture native question round'
const question = 'Which synthetic city should the fixture use?'
const answer = 'Fixture Dublin'
const finalText = 'Synthetic question was answered and the canonical turn resumed.'
const MAX_DIAGNOSTIC_COUNT = 1_000
const TURN_STATUSES = ['queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user', 'interrupted', 'cancelled', 'failed', 'completed'] as const
const QUESTION_STATUSES = ['queued', 'started', 'completed', 'failed', 'interrupted', 'cancelled'] as const
const STEP_STATUSES = ['queued', 'streaming', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user', 'completed', 'failed', 'interrupted'] as const
const TASK_STATUSES = ['queued', 'running', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed', 'passed', 'retrying', 'skipped'] as const

function diagnosticCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_DIAGNOSTIC_COUNT) : 0
}

function statusCounts(rows: { status: string }[], allowed: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries([...allowed, 'other'].map(status => [status, 0]))
  for (const row of rows) counts[allowed.includes(row.status) ? row.status : 'other'] += 1
  return Object.fromEntries(Object.entries(counts).map(([status, count]) => [status, diagnosticCount(count)]))
}

function statusCategory(value: string | null, allowed: readonly string[]): string {
  return value === null ? 'absent' : allowed.includes(value) ? value : 'other'
}

async function logBoundedTurnDiagnostic(phase: 'awaiting_question' | 'after_answer', sessionId: string, turnId: string,
  inspectTurn: (sessionId: string, turnId: string) => Promise<{
    turn: { status: string; error: string | null; completedEvents: number; answeredEvents: number }
    questions: { status: string; content: { answer?: string | null } }[]
    eventTypes: string[]
    steps: { status: string; errorCode: string | null; finishReason: string | null }[]
    tasks: { status: string; failureReason: string | null }[]
    toolResultCount: number
    toolResultQuestionRedacted: boolean | null
    wakeupOutbox: { count: number; publishedCount: number; maxAttemptCount: number }
    turnDispatchOutbox: { count: number; publishedCount: number; maxAttemptCount: number; lastErrorCategory: string }
    turnDlq: { count: number; maxAttemptCount: number; reasonSchemaInvalidPayload: number; reasonMaxRetriesExhausted: number; reasonExecutionFailed: number; reasonLeaseLost: number; reasonResumeFenceInvalid: number; reasonOther: number; errorInvalidPayload: number; errorTurnExecution: number; errorLeaseNotAvailable: number; errorLeaseLost: number; errorResumeFenceInvalid: number; errorOther: number }
  }>) {
  try {
    const state = await inspectTurn(sessionId, turnId)
    const countEvents = (type: string) => diagnosticCount(state.eventTypes.filter(eventType => eventType === type).length)
    console.error('Synthetic turn bounded diagnostic', JSON.stringify({
      phase,
      stateAvailable: true,
      turnStatus: statusCategory(state.turn.status, TURN_STATUSES),
      turnErrorPresent: Boolean(state.turn.error),
      questionCount: diagnosticCount(state.questions.length),
      questionStatusCounts: statusCounts(state.questions, QUESTION_STATUSES),
      questionAnswerPresent: state.questions.some(item => item.content.answer != null),
      eventCounts: {
        wakeup: countEvents('turn.wakeup'),
        resumed: countEvents('turn.resumed'),
        answered: countEvents('question.answered'),
        completed: countEvents('turn.completed'),
        failed: countEvents('turn.failed'),
      },
      completedEvents: diagnosticCount(state.turn.completedEvents),
      answeredEvents: diagnosticCount(state.turn.answeredEvents),
      wakeupOutboxCount: diagnosticCount(state.wakeupOutbox.count),
      wakeupOutboxPublished: state.wakeupOutbox.publishedCount > 0,
      wakeupOutboxPublishedCount: diagnosticCount(state.wakeupOutbox.publishedCount),
      wakeupOutboxMaxAttemptCount: diagnosticCount(state.wakeupOutbox.maxAttemptCount),
      turnDispatchOutboxCount: diagnosticCount(state.turnDispatchOutbox.count),
      turnDispatchOutboxPublished: state.turnDispatchOutbox.publishedCount > 0,
      turnDispatchOutboxPublishedCount: diagnosticCount(state.turnDispatchOutbox.publishedCount),
      turnDispatchOutboxMaxAttemptCount: diagnosticCount(state.turnDispatchOutbox.maxAttemptCount),
      turnDispatchOutboxLastErrorCategory: ['none', 'queue_add_failed', 'turn_dispatch_lineage_mismatch', 'schema_invalid_payload'].includes(state.turnDispatchOutbox.lastErrorCategory)
        ? state.turnDispatchOutbox.lastErrorCategory : 'other',
      turnDlqCount: diagnosticCount(state.turnDlq.count),
      turnDlqMaxAttemptCount: diagnosticCount(state.turnDlq.maxAttemptCount),
      turnDlqReasonCounts: {
        schemaInvalidPayload: diagnosticCount(state.turnDlq.reasonSchemaInvalidPayload),
        maxRetriesExhausted: diagnosticCount(state.turnDlq.reasonMaxRetriesExhausted),
        executionFailed: diagnosticCount(state.turnDlq.reasonExecutionFailed),
        leaseLost: diagnosticCount(state.turnDlq.reasonLeaseLost),
        resumeFenceInvalid: diagnosticCount(state.turnDlq.reasonResumeFenceInvalid),
        other: diagnosticCount(state.turnDlq.reasonOther),
      },
      turnDlqErrorCounts: {
        invalidPayload: diagnosticCount(state.turnDlq.errorInvalidPayload),
        turnExecution: diagnosticCount(state.turnDlq.errorTurnExecution),
        leaseNotAvailable: diagnosticCount(state.turnDlq.errorLeaseNotAvailable),
        leaseLost: diagnosticCount(state.turnDlq.errorLeaseLost),
        resumeFenceInvalid: diagnosticCount(state.turnDlq.errorResumeFenceInvalid),
        other: diagnosticCount(state.turnDlq.errorOther),
      },
      stepStatusCounts: statusCounts(state.steps, STEP_STATUSES),
      stepErrorPresentCount: diagnosticCount(state.steps.filter(step => Boolean(step.errorCode)).length),
      stepFinishReasonPresentCount: diagnosticCount(state.steps.filter(step => Boolean(step.finishReason)).length),
      taskStatusCounts: statusCounts(state.tasks, TASK_STATUSES),
      taskFailurePresentCount: diagnosticCount(state.tasks.filter(task => Boolean(task.failureReason)).length),
      toolResultCount: diagnosticCount(state.toolResultCount),
      toolResultQuestionRedacted: state.toolResultQuestionRedacted,
    }))
  } catch {
    console.error('Synthetic turn bounded diagnostic', JSON.stringify({ phase, stateAvailable: false }))
  }
}

async function logFinalVisibilityDiagnostic(sessionId: string, turnId: string, request: APIRequestContext,
  inspect: (sessionId: string, turnId: string, timelineHttpCategory: string) => Promise<Record<string, unknown>>) {
  let timelineHttpCategory = 'unavailable'
  try {
    const path = '/api/agent/sessions/' + encodeURIComponent(sessionId) + '/timeline?limit=100'
    const response = await request.get(path, { timeout: 5_000, maxRedirects: 0 })
    const status = response.status()
    timelineHttpCategory = response.ok() ? 'ok' : status === 404 ? 'not_found' : status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : 'other'
  } catch { /* The fixed category remains unavailable. */ }
  try { console.error('Synthetic final visibility diagnostic', JSON.stringify(await inspect(sessionId, turnId, timelineHttpCategory))) }
  catch { console.error('Synthetic final visibility diagnostic', JSON.stringify({ stateAvailable: false, timelineHttpCategory })) }
}

test('synthetic native question resumes the actual authenticated turn', async ({ browser }) => {
  if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
    || process.env.APPLICATION_AUTH_AGENT_REVIEWED_EXECUTION !== 'true'
    || process.env.DATABASE_URL !== 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
    || process.env.DIRECT_URL !== process.env.DATABASE_URL || process.env.RLS_RUNTIME_MODE !== 'off'
    || process.env.REDIS_URL !== 'redis://redis:6379/15' || process.env.PLATFORM_ENV !== 'development'
    || process.env.AGENT_WEB_URL !== origin || process.env.AGENT_WORKER_SECRET !== 'fixture-only-worker-secret-at-least-32-bytes') throw new Error('Not the reviewed disposable fixture')

  const context = await browser.newContext({ baseURL: origin })
  const requireFixture = createRequire(path.resolve('e2e/application-authenticated-agent.browser.ts'))
  const { initializeFixtureSse, inspectTurn, inspectFinalVisibility, closeFixtureDb } = requireFixture('./application-authenticated-agent-db.cjs') as {
    initializeFixtureSse: () => Promise<void>
    inspectTurn: (sessionId: string, turnId: string) => Promise<{ turn: { status: string; error: string | null; completedEvents: number; answeredEvents: number; finalResponse: string | null }; questions: { id: string; status: string; content: { questionId?: string; question?: string; answer?: string | null; toolCallId?: string } }[]; eventTypes: string[]; steps: { status: string; errorCode: string | null; finishReason: string | null }[]; tasks: { status: string; failureReason: string | null }[]; toolResultCount: number; toolResultQuestionRedacted: boolean | null; wakeupOutbox: { count: number; publishedCount: number; maxAttemptCount: number }; turnDispatchOutbox: { count: number; publishedCount: number; maxAttemptCount: number; lastErrorCategory: string }; turnDlq: { count: number; maxAttemptCount: number; reasonSchemaInvalidPayload: number; reasonMaxRetriesExhausted: number; reasonExecutionFailed: number; reasonLeaseLost: number; reasonResumeFenceInvalid: number; reasonOther: number; errorInvalidPayload: number; errorTurnExecution: number; errorLeaseNotAvailable: number; errorLeaseLost: number; errorResumeFenceInvalid: number; errorOther: number } }>
    inspectFinalVisibility: (sessionId: string, turnId: string, timelineHttpCategory: string) => Promise<Record<string, unknown>>
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
    } catch {
      await logBoundedTurnDiagnostic('awaiting_question', sessionId, turnId, inspectTurn)
      throw new Error('Turn did not reach the expected question wait state; see bounded diagnostics')
    }
    const waiting = await inspectTurn(sessionId, turnId)
    expect(waiting.turn.status).toBe('waiting_for_user')
    expect(waiting.questions).toHaveLength(1)
    expect(waiting.questions[0].status).toBe('started')
    expect(waiting.questions[0].content).toMatchObject({ question, toolCallId: 'fixture-native-question', answer: null })
    expect(waiting.questions[0].content.questionId).toBeTruthy()

    const eventResponse = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/agent/sessions/${encodeURIComponent(sessionId)}/events`)
    await page.goto(`/?page=agent&sessionId=${encodeURIComponent(sessionId)}`)
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
      && response.url().endsWith(`/api/agent/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(waiting.questions[0].content.questionId!)}`))
    await card.getByRole('button', { name: /^(Send answer|发送回答)$/ }).click()
    const answered = await submitted
    expect(answered.status()).toBe(202)
    expect((await answered.json()).disposition).toBe('resolved')
    try {
      await expect.poll(async () => {
        const response = await page.request.get(turnsUrl)
        if (!response.ok()) return 'unavailable'
        const body = await response.json()
        return body.turns.find((turn: { id: string }) => turn.id === turnId)?.status ?? 'missing'
      }, { timeout: 60_000 }).toBe('completed')
    } catch {
      await logBoundedTurnDiagnostic('after_answer', sessionId, turnId, inspectTurn)
      throw new Error('Turn did not complete after the accepted answer; see bounded diagnostics')
    }
    try {
      await expect(page.getByText(finalText, { exact: false })).toBeVisible({ timeout: 30_000 })
    } catch {
      await logFinalVisibilityDiagnostic(sessionId, turnId, page.request, inspectFinalVisibility)
      throw new Error('Final response visibility assertion failed; see bounded diagnostics')
    }
    const finished = await inspectTurn(sessionId, turnId)
    expect(finished.turn).toMatchObject({ status: 'completed', completedEvents: 1, answeredEvents: 1 })
    expect(finished.turn.finalResponse).toContain(finalText)
    expect(finished.questions).toHaveLength(1)
    expect(finished.questions[0]).toMatchObject({ status: 'completed', content: { question, answer } })

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
    } finally { await other.close() }
  } finally { await context.close(); await closeFixtureDb() }
})
