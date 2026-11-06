import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

const origin = 'http://127.0.0.1:3100'
const expectedDb = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
const jobFixture = {
  id: 'fixture-preparation', title: 'Fixture application engineer', company: 'Fixture Company',
  location: 'Dublin', url: 'https://employer.example.invalid/jobs/fixture-preparation',
  description: 'Synthetic vacancy for isolated preparation and review.', source: 'fixture', score: 0,
}

test('real login prepares and reviews a synthetic application through the actual routes', async ({ browser }) => {
  if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
    || process.env.APPLICATION_AUTH_PREPARATION_FIXTURE !== 'true' || process.env.DATABASE_URL !== expectedDb
    || process.env.DIRECT_URL !== expectedDb || process.env.RLS_RUNTIME_MODE !== 'off') throw new Error('Refusing non-fixture test')
  const context = await browser.newContext()
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/api/search/unified') return route.fulfill({ json: { jobs: [jobFixture], meta: { sourcesUsed: ['fixture'], routing: 'fixture', totalRaw: 1, totalDeduped: 1, durationMs: 1 } } })
    return route.continue()
  })
  const page = await context.newPage()
  const writes: string[] = []
  page.on('request', req => { if (req.method() !== 'GET') writes.push(`${req.method()} ${new URL(req.url()).pathname}`) })
  await page.goto('/login')
  await page.getByPlaceholder('you@example.com').fill('candidate-a@example.invalid')
  await page.locator('input[type="password"]').fill('Fixture-only-password-123')
  await page.getByRole('button', { name: /^(Sign in|Log in)$/ }).click()
  await page.waitForURL(url => url.pathname === '/')
  expect((await (await page.request.get('/api/auth/session')).json()).user.email).toBe('candidate-a@example.invalid')

  await page.goto('/?page=search')
  const search = page.getByRole('textbox', { name: /Search jobs|搜索职位/ })
  await search.fill(jobFixture.title)
  await search.press('Enter')
  await expect(page.getByText(jobFixture.title, { exact: true }).first()).toBeVisible()
  const savedResponse = page.waitForResponse(r => r.url() === `${origin}/api/jobs` && r.request().method() === 'POST')
  const defaultResumeResponse = page.waitForResponse(r => r.url() === `${origin}/api/resume/default` && r.request().method() === 'GET')
  await page.getByTitle(/Save to My Jobs|保存到我的职位/).click()
  const saved = await savedResponse
  expect(saved.status()).toBe(201)
  expect((await defaultResumeResponse).status()).toBe(404)
  const job = await saved.json()
  expect(job).toMatchObject({ company: jobFixture.company, role: jobFixture.title, status: 'saved', workflowState: 'draft' })
  const baseResponse = await page.request.post('/api/resume', { data: {
    name: 'Synthetic fixture source', isDefault: true, kind: 'base', origin: 'manual',
    content: { contact: { name: 'Fixture Candidate', email: 'candidate-a@example.invalid', location: 'Dublin' },
      summary: 'Synthetic original summary.', experience: [], education: [], skills: ['TypeScript'], languages: [], projects: [], certifications: [] },
  } })
  expect(baseResponse.status()).toBe(201)
  const base = await baseResponse.json()
  await page.goto(`/?page=jobs&highlight=${job.id}`)
  const drawer = page.getByRole('dialog')
  await expect(drawer).toContainText(jobFixture.title)
  const prepare = drawer.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true })
  await expect(prepare).toBeEnabled()
  const tailorResponse = page.waitForResponse(r => r.url().endsWith(`/api/jobs/${job.id}/tailor-resume`) && r.request().method() === 'POST')
  const auditResponse = page.waitForResponse(r => r.url().endsWith(`/api/jobs/${job.id}/audit-application`) && r.request().method() === 'POST')
  const assignResponse = page.waitForResponse(r => r.url().endsWith(`/api/jobs/${job.id}/assign`) && r.request().method() === 'PATCH')
  await prepare.click()
  const tailor = await tailorResponse
  expect(tailor.status()).toBe(200)
  const tailored = await tailor.json()
  expect(tailored.adaptedResumeId).toBeTruthy()
  expect(tailored.adaptedResumeId).not.toBe(base.id)
  expect(tailored.changes.map((change: { section: string }) => change.section).sort()).toEqual(
    ['summary', 'skills', 'experience', 'education', 'projects', 'certifications'].sort(),
  )
  const audit = await auditResponse
  expect(audit.status()).toBe(200)
  expect(audit.request().postDataJSON()).toMatchObject({ resumeId: tailored.adaptedResumeId, coverLetterId: null })
  expect(audit.request().headers()['x-application-audit-attempt-id']).toMatch(/^[0-9a-f-]{36}$/i)
  const auditBody = await audit.json()
  expect(auditBody).toMatchObject({ verdict: 'pass', summary: 'Synthetic model audit; no real provider was called.', source: 'parent_resume' })
  expect(auditBody.operationId).toMatch(/^[0-9a-f-]{36}$/i)
  const assigned = await assignResponse
  expect(assigned.status()).toBe(200)
  expect(assigned.request().postDataJSON()).toMatchObject({ finalResumeId: tailored.adaptedResumeId })
  await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toBeVisible()
  const canonical = await page.request.get(`/api/jobs/${job.id}/audit-application`)
  expect(canonical.status()).toBe(200)
  const receipt = await canonical.json()
  expect(receipt).toMatchObject({ operationId: auditBody.operationId, resumeId: tailored.adaptedResumeId,
    resumeUpdatedAt: auditBody.resumeUpdatedAt, coverLetterId: null, audit: { verdict: 'pass', summary: auditBody.summary } })
  expect(receipt.receipt.signature).toMatch(/^[a-f0-9]{64}$/)

  const requireWeb = createRequire(path.resolve('apps/web/package.json'))
  const { PrismaClient } = requireWeb('@prisma/client')
  const db = new PrismaClient()
  try {
    const identity = await db.$queryRaw`SELECT current_database() AS name`
    expect(identity[0]?.name).toBe('application_flow_fixture')
    const user = await db.user.findUniqueOrThrow({ where: { email: 'candidate-a@example.invalid' } })
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } })
    const adapted = await db.resume.findUniqueOrThrow({ where: { id: tailored.adaptedResumeId } })
    expect(row).toMatchObject({ userId: user.id, status: 'saved', workflowState: 'draft', finalResumeId: adapted.id, appliedAt: null })
    expect(adapted).toMatchObject({ userId: user.id, targetJobId: job.id, parentResumeId: base.id, kind: 'adapted' })
    const controlId = `auditop_${createHash('sha256').update(JSON.stringify(['applymate.audit-operation', 1, user.id, job.id])).digest('hex')}`
    const control = await db.activity.findUniqueOrThrow({ where: { id: controlId } })
    expect(control).toMatchObject({ userId: user.id, jobId: job.id })
    const prefix = '[Auditor] application-audit operation-v1 '
    expect(control.text.startsWith(prefix)).toBe(true)
    expect(JSON.parse(control.text.slice(prefix.length))).toMatchObject({ state: 'completed', operationId: auditBody.operationId })
    expect(await db.applyResult.count({ where: { userId: user.id, jobId: job.id } })).toBe(0)
    expect(await db.activity.count({ where: { userId: user.id, jobId: job.id, type: 'applied' } })).toBe(0)
  } finally { await db.$disconnect() }
  const reread = page.waitForResponse(r => r.url().endsWith(`/api/jobs/${job.id}/audit-application`) && r.request().method() === 'GET')
  await page.reload()
  await expect(page.getByRole('dialog')).toContainText(jobFixture.title)
  const rereadResponse = await reread
  expect(rereadResponse.status()).toBe(200)
  expect((await rereadResponse.json()).operationId).toBe(auditBody.operationId)
  expect(writes.filter(value => value === `POST /api/jobs/${job.id}/tailor-resume`)).toHaveLength(1)
  expect(writes.filter(value => value === `POST /api/jobs/${job.id}/audit-application`)).toHaveLength(1)
  expect(writes.filter(value => value === `PATCH /api/jobs/${job.id}/assign`)).toHaveLength(1)
  expect(writes.filter(value => value === `POST /api/jobs/${job.id}/apply`)).toHaveLength(0)
  await context.close()
})
