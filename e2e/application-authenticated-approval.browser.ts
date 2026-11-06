// A seeded synthetic Turn tests existing approval UI/broker only. It does not
// start a Worker queue or prove actual application submission or receipt.
import { createRequire } from 'node:module'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const origin = 'http://127.0.0.1:3100'
const dbUrl = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
const sessionId = 'fixture-approval-session'
const turnId = 'fixture-approval-turn'
const approvalId = 'fixture-approval-receipt'
const jobId = 'fixture-approval-job'
const approvalPath = `/api/agent/sessions/${sessionId}/approvals/${approvalId}`

async function login(page: Page, email: string) {
  await page.goto('/login')
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.locator('input[type="password"]').fill('Fixture-only-password-123')
  await page.getByRole('button', { name: /^(Sign in|Log in)$/ }).click()
  await page.waitForURL(url => url.origin === origin && url.pathname === '/')
  expect((await (await page.request.get('/api/auth/session')).json()).user.email).toBe(email)
}

test('authenticated application opens its original session and decides a synthetic approval', async ({ browser }) => {
  if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
    || process.env.APPLICATION_AUTH_APPROVAL_FIXTURE !== 'true' || process.env.DATABASE_URL !== dbUrl
    || process.env.DIRECT_URL !== dbUrl || process.env.RLS_RUNTIME_MODE !== 'off'
    || process.env.AGENT_PREVIEW_FIXTURE || process.env.ENABLE_AGENT_CANONICAL_AUTOMATION === '1') throw new Error('Not the isolated approval fixture')
  const requireWorker = createRequire(path.resolve('apps/worker/package.json'))
  const { Pool } = requireWorker('pg') as { Pool: new (options: { connectionString: string; max: number }) => {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void>
  } }
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const context = await browser.newContext({ baseURL: origin })
  const other = await browser.newContext({ baseURL: origin })
  try {
    const database = await pool.query('SELECT current_database() AS name')
    const users = await pool.query('SELECT "email" FROM "User" ORDER BY "email"')
    expect(database.rows[0].name).toBe('application_flow_fixture')
    expect(users.rows.map(row => row.email)).toEqual(['candidate-a@example.invalid', 'candidate-b@example.invalid'])
    const state = async () => (await pool.query(`SELECT approval."status" AS approval_status, turn."status" AS turn_status,
      turn."revision" AS turn_revision, item."status" AS item_status, job."status" AS job_status, task."status" AS task_status,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'approval.resolved') AS resolved,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'turn.wakeup') AS wakeups,
      (SELECT COUNT(*)::int FROM "agent_action_reservations" WHERE "approvalId" = $2) AS reservations
      FROM "agent_approvals" approval JOIN "agent_turns" turn ON turn."id" = approval."turnId"
      JOIN "agent_sessions" session ON session."id" = approval."sessionId" AND session."userId" = approval."userId"
      JOIN "User" candidate ON candidate."id" = session."userId"
      JOIN "Job" job ON job."id" = approval."jobId" AND job."userId" = candidate."id"
      JOIN "application_tasks" task ON task."id" = 'fixture-approval-task' AND task."jobId" = job."id"
        AND task."sessionId" = session."id" AND task."userId" = candidate."id"
      JOIN "agent_items" item ON item."id" = $3 AND item."turnId" = turn."id"
      WHERE session."id" = $1 AND approval."id" = $2 AND candidate."email" = 'candidate-a@example.invalid'`,
      [sessionId, approvalId, `agent-wait:approval:${approvalId}`])).rows
    const initial = await state()
    expect(initial).toEqual([{ approval_status: 'pending', turn_status: 'waiting_for_approval', turn_revision: 1,
      item_status: 'started', job_status: 'saved', task_status: 'waiting_for_authorization', resolved: 0, wakeups: 0, reservations: 0 }])
    for (const browserContext of [context, other]) await browserContext.route('**/*', route =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    const otherPage = await other.newPage()
    const applicationMutations: string[] = []
    context.on('request', request => {
      const pathname = new URL(request.url()).pathname
      if (request.method() !== 'GET' && (pathname === `/api/jobs/${jobId}/apply` || pathname === '/api/auto-apply'
        || pathname === '/api/agent/application-tasks' || pathname === `/api/agent/sessions/${sessionId}/actions`)) {
        applicationMutations.push(`${request.method()} ${pathname}`)
      }
    })
    await login(page, 'candidate-a@example.invalid')
    await login(otherPage, 'candidate-b@example.invalid')
    const request = { clientMessageId: 'fixture-stale-approval', expectedTurnId: turnId, expectedRevision: 0, decision: 'approved' }
    expect((await otherPage.request.post(approvalPath, { data: request })).status()).toBe(404)
    expect((await page.request.post(approvalPath, { data: request })).status()).toBe(409)
    expect(await state()).toEqual(initial)
    const tasks = await page.request.get('/api/agent/application-tasks')
    expect(tasks.status()).toBe(200)
    expect((await tasks.json()).tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fixture-approval-task', jobId, sessionId, status: 'waiting_for_authorization' })]))
    await page.goto(`/?page=jobs&highlight=${jobId}`)
    await expect(page.getByRole('dialog')).toContainText('Fixture Approval Engineer')
    await page.getByRole('link', { name: /Review in Agent|前往 Agent 审核/ }).click()
    await expect(page).toHaveURL(/page=agent/)
    await expect(page).toHaveURL(new RegExp(`sessionId=${sessionId}`))
    await page.getByRole('button', { name: /^(Tasks & results|任务与结果)/ }).click()
    const ledger = page.locator('[data-agent-approval-ledger="true"]')
    await expect(ledger).toBeVisible()
    const submitted = page.waitForResponse(response => new URL(response.url()).pathname === approvalPath && response.request().method() === 'POST')
    await ledger.getByRole('button', { name: /^(Approve|批准)$/ }).click()
    const response = await submitted
    expect(response.status()).toBe(202)
    expect(await response.json()).toMatchObject({ disposition: 'resolved', status: 'approved', turnId })
    expect(await state()).toEqual([{ approval_status: 'approved', turn_status: 'waiting_for_approval', turn_revision: 2,
      item_status: 'completed', job_status: 'saved', task_status: 'waiting_for_authorization', resolved: 1, wakeups: 1, reservations: 0 }])
    const lineage = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "correlationId" = $3 AND "type" = 'approval.requested' AND "taskId" = 'fixture-approval-task') AS requested_for_task,
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "correlationId" = $3 AND "type" = 'approval.resolved' AND "taskId" IS NULL) AS resolved_without_task`,
      [sessionId, turnId, approvalId])
    console.info('Synthetic approval event scope', JSON.stringify(lineage.rows[0]))
    // A reload reconstructs the decision from persisted events rather than
    // relying on transient button feedback in the current React tree.
    await page.reload()
    await page.getByRole('button', { name: /^(Tasks & results|任务与结果)/ }).click()
    const reloadedLedger = page.locator('[data-agent-approval-ledger="true"]')
    await expect(reloadedLedger).toBeVisible()
    await expect(reloadedLedger.getByRole('button', { name: /^(Approve|批准)$/ })).toHaveCount(0)
    await expect(reloadedLedger.getByText(/^(Approved|已批准)$/)).toBeVisible()
    expect(applicationMutations).toEqual([])
  } finally {
    await context.close()
    await other.close()
    await pool.end()
  }
})
