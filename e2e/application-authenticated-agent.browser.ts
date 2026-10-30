// This uses real Web/Worker/database paths with a synthetic model; it is not
// an application, approval, external submission, or employer receipt test.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const origin = 'http://127.0.0.1:3100'
const goal = 'Fixture native question round'
const question = 'Which synthetic city should the fixture use?'
const answer = 'Fixture Dublin'
const finalText = 'Synthetic question was answered and the canonical turn resumed.'

test('synthetic native question resumes the actual authenticated turn', async ({ browser }) => {
  if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
    || process.env.APPLICATION_AUTH_AGENT_REVIEWED_EXECUTION !== 'true'
    || process.env.DATABASE_URL !== 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
    || process.env.DIRECT_URL !== process.env.DATABASE_URL || process.env.RLS_RUNTIME_MODE !== 'off'
    || process.env.REDIS_URL !== 'redis://redis:6379/15' || process.env.PLATFORM_ENV !== 'development'
    || process.env.AGENT_WEB_URL !== origin || process.env.AGENT_WORKER_SECRET !== 'fixture-only-worker-secret-at-least-32-bytes') throw new Error('Not the reviewed disposable fixture')

  const context = await browser.newContext({ baseURL: origin })
  const requireFixture = createRequire(path.resolve('e2e/application-authenticated-agent.browser.ts'))
  const { initializeFixtureSse, inspectTurn, closeFixtureDb } = requireFixture('./application-authenticated-agent-db.cjs') as {
    initializeFixtureSse: () => Promise<void>
    inspectTurn: (sessionId: string, turnId: string) => Promise<{ turn: { status: string; completedEvents: number; answeredEvents: number; finalResponse: string | null }; questions: { id: string; status: string; content: { questionId?: string; question?: string; answer?: string | null; toolCallId?: string } }[] }>
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
    await expect.poll(async () => {
      const response = await page.request.get(turnsUrl)
      if (!response.ok()) return 'unavailable'
      const body = await response.json()
      return body.projection.activeTurn?.id === turnId ? body.projection.activeTurn.status : 'other'
    }, { timeout: 60_000 }).toBe('waiting_for_user')
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
    await expect.poll(async () => {
      const response = await page.request.get(turnsUrl)
      if (!response.ok()) return 'unavailable'
      const body = await response.json()
      return body.turns.find((turn: { id: string }) => turn.id === turnId)?.status ?? 'missing'
    }, { timeout: 60_000 }).toBe('completed')
    await expect(page.getByText(finalText, { exact: false })).toBeVisible({ timeout: 30_000 })
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
