import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
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
    if (url.href === jobFixture.url) return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Synthetic employer fixture</h1>' })
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/api/search/unified') return route.fulfill({ json: { jobs: [jobFixture], meta: { sourcesUsed: ['fixture'], routing: 'fixture', totalRaw: 1, totalDeduped: 1, durationMs: 1 } } })
    return route.continue()
  })
  const page = await context.newPage()
  const writes: string[] = []
  type FixturePhase = 'setup' | 'preparation' | 'editing' | 'return' | 'reaudit' | 'download' | 'employer' | 'manual_record'
  let phase: FixturePhase = 'setup'
  const requestPhases = new WeakMap<object, FixturePhase>()
  let loggedFailures = 0
  page.on('request', req => {
    requestPhases.set(req, phase)
    if (req.method() !== 'GET') writes.push(`${req.method()} ${new URL(req.url()).pathname}`)
  })
  page.on('response', response => {
    if (response.status() !== 409 && response.status() !== 503) return
    const pathname = new URL(response.url()).pathname
    const route = /^\/api\/jobs\/[^/]+\/audit-application(?:\/apply)?$/.test(pathname) ? 'audit'
      : /^\/api\/jobs\/[^/]+\/tailor-resume$/.test(pathname) ? 'tailor'
        : /^\/api\/jobs\/[^/]+\/assign$/.test(pathname) ? 'assign'
          : /^\/api\/jobs\/[^/]+\/(?:application-pack|export-local)$/.test(pathname) ? 'download'
            : /^\/api\/jobs\/[^/]+\/apply$/.test(pathname) ? 'application_record'
              : /^\/api\/resume\/[^/]+$/.test(pathname) ? 'resume' : null
    if (!route) return
    loggedFailures++
    if (loggedFailures > 20) {
      if (loggedFailures === 21) console.log('Fixture material response diagnostics truncated')
      return
    }
    const method = response.request().method()
    console.log('Fixture material response', JSON.stringify({ phase: requestPhases.get(response.request()) ?? 'setup', route,
      method: ['GET', 'POST', 'PATCH'].includes(method) ? method : 'OTHER', status: response.status() }))
  })
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
  phase = 'preparation'
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

  // Edit the same selected document using the application's real navigation.
  // Removing a period changes the material version without adding any fact.
  const resumedDrawer = page.getByRole('dialog')
  phase = 'editing'
  await resumedDrawer.getByRole('button', { name: 'Show Resume details' }).click()
  await resumedDrawer.getByRole('button', { name: /Edit this resume|编辑此简历/, exact: true }).click()
  await expect(page).toHaveURL(/page=resume/)
  const editor = page.locator('[data-resume-editor]')
  await editor.getByText('Synthetic original summary.', { exact: false }).first().click()
  const saveResponse = page.waitForResponse(response => response.url().endsWith(`/api/resume/${tailored.adaptedResumeId}`) && response.request().method() === 'PATCH')
  await editor.locator('textarea').first().fill('Synthetic original summary')
  const savedEdit = await saveResponse
  expect(savedEdit.status()).toBe(200)
  const edited = await savedEdit.json()
  expect(edited).toMatchObject({ id: tailored.adaptedResumeId, content: { summary: 'Synthetic original summary' } })
  expect(edited.updatedAt).not.toBe(auditBody.resumeUpdatedAt)
  await expect(page.locator('.resume-top-save')).toContainText(/Saved just now|刚刚保存/)
  phase = 'return'
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page).toHaveURL(new RegExp(`highlight=${job.id}`))
  const returnedDrawer = page.getByRole('dialog')
  await expect(returnedDrawer).toContainText(jobFixture.title)
  const stale = await page.request.get(`/api/jobs/${job.id}/audit-application`)
  expect(stale.status()).toBe(200)
  expect(await stale.json()).toMatchObject({ state: 'stale' })
  await expect(returnedDrawer.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
  expect(writes.filter(value => value === `POST /api/jobs/${job.id}/audit-application`)).toHaveLength(1)

  // A second review is deliberate and uses the edited version, not a new resume.
  const recheck = returnedDrawer.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
  await expect(recheck).toBeEnabled()
  const secondAuditResponse = page.waitForResponse(r => r.url().endsWith(`/api/jobs/${job.id}/audit-application`) && r.request().method() === 'POST')
  const secondAssignResponse = page.waitForResponse(r => r.url().endsWith(`/api/jobs/${job.id}/assign`) && r.request().method() === 'PATCH')
  phase = 'reaudit'
  await recheck.click()
  const secondAudit = await secondAuditResponse
  expect(secondAudit.status()).toBe(200)
  expect(secondAudit.request().postDataJSON()).toMatchObject({ resumeId: tailored.adaptedResumeId, coverLetterId: null })
  const secondAuditBody = await secondAudit.json()
  expect(secondAuditBody).toMatchObject({ verdict: 'pass', resumeUpdatedAt: edited.updatedAt, source: 'parent_resume' })
  expect(secondAuditBody.operationId).not.toBe(auditBody.operationId)
  const secondAssign = await secondAssignResponse
  expect(secondAssign.status()).toBe(200)
  expect(secondAssign.request().postDataJSON()).toMatchObject({ finalResumeId: tailored.adaptedResumeId })
  const current = await page.request.get(`/api/jobs/${job.id}/audit-application`)
  expect(current.status()).toBe(200)
  const currentReceipt = await current.json()
  expect(currentReceipt).toMatchObject({ operationId: secondAuditBody.operationId, resumeId: tailored.adaptedResumeId,
    resumeUpdatedAt: edited.updatedAt, audit: { verdict: 'pass' } })
  expect(currentReceipt.receipt.signature).toMatch(/^[a-f0-9]{64}$/)
  await expect(returnedDrawer.getByRole('button', { name: /Download application materials|下载申请材料/ })).toBeVisible()
  expect(writes.filter(value => value === `POST /api/jobs/${job.id}/tailor-resume`)).toHaveLength(1)
  expect(writes.filter(value => value === `POST /api/jobs/${job.id}/audit-application`)).toHaveLength(2)
  expect(writes.filter(value => value === `PATCH /api/jobs/${job.id}/assign`)).toHaveLength(2)
  const finalReread = page.waitForResponse(r => r.url().endsWith(`/api/jobs/${job.id}/audit-application`) && r.request().method() === 'GET')
  await page.reload()
  await expect(page.getByRole('dialog')).toContainText(jobFixture.title)
  const finalRereadResponse = await finalReread
  expect(finalRereadResponse.status()).toBe(200)
  expect((await finalRereadResponse.json()).operationId).toBe(secondAuditBody.operationId)
  expect(writes.filter(value => value === `POST /api/jobs/${job.id}/tailor-resume`)).toHaveLength(1)
  expect(writes.filter(value => value === `POST /api/jobs/${job.id}/audit-application`)).toHaveLength(2)
  expect(writes.filter(value => value === `PATCH /api/jobs/${job.id}/assign`)).toHaveLength(2)

  const finalDb = new PrismaClient()
  try {
    const user = await finalDb.user.findUniqueOrThrow({ where: { email: 'candidate-a@example.invalid' } })
    const assertStillSaved = async () => {
      const savedJob = await finalDb.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(savedJob).toMatchObject({ userId: user.id, status: 'saved', workflowState: 'draft', finalResumeId: tailored.adaptedResumeId, appliedAt: null })
      expect(await finalDb.activity.count({ where: { userId: user.id, jobId: job.id, type: 'applied' } })).toBe(0)
      expect(await finalDb.applyResult.count({ where: { userId: user.id, jobId: job.id } })).toBe(0)
    }
    const controlId = `auditop_${createHash('sha256').update(JSON.stringify(['applymate.audit-operation', 1, user.id, job.id])).digest('hex')}`
    const control = await finalDb.activity.findUniqueOrThrow({ where: { id: controlId } })
    const prefix = '[Auditor] application-audit operation-v1 '
    expect(control.text.startsWith(prefix)).toBe(true)
    expect(JSON.parse(control.text.slice(prefix.length))).toMatchObject({ state: 'completed', operationId: secondAuditBody.operationId })
    await assertStillSaved()

    phase = 'download'
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await returnedDrawer.getByRole('button', { name: /Download application materials|下载申请材料/ }).click()
    const download = await downloadPromise
    const archivePath = await download.path()
    if (!archivePath) throw new Error('Fixture ZIP is unavailable')
    const JSZip = requireWeb('jszip') as { loadAsync: (bytes: Buffer) => Promise<{ files: Record<string, { dir: boolean; async: (type: 'string' | 'nodebuffer') => Promise<string | Buffer> }> }> }
    const archive = await JSZip.loadAsync(await readFile(archivePath))
    const names = Object.keys(archive.files).filter(name => !archive.files[name].dir)
    const metaName = names.find(name => name.endsWith('meta.json'))
    const pdfs = names.filter(name => name.toLowerCase().endsWith('.pdf'))
    expect(metaName).toBeTruthy()
    expect(pdfs).toHaveLength(1)
    const metadata = JSON.parse(await archive.files[metaName!].async('string') as string)
    expect(metadata).toMatchObject({ job: { id: job.id, url: jobFixture.url },
      resume: { id: tailored.adaptedResumeId, updatedAt: edited.updatedAt }, audit: { verdict: 'pass', auditedAt: currentReceipt.audit.auditedAt } })
    const pdfBytes = await archive.files[pdfs[0]].async('nodebuffer') as Buffer
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
    const parsePdf = requireWeb('pdf-parse') as (bytes: Uint8Array) => Promise<{ text: string }>
    const pdfText = (await parsePdf(Uint8Array.from(pdfBytes))).text
    expect(pdfText).toMatch(/Synthetic\s+original\s+summary/)
    expect(pdfText).not.toMatch(/Synthetic\s+original\s+summary\s*\./)
    await assertStillSaved()

    phase = 'employer'
    const popupPromise = context.waitForEvent('page')
    await returnedDrawer.getByRole('button', { name: /Open employer website|前往雇主网站/, exact: true }).click()
    const employer = await popupPromise
    await expect(employer.getByRole('heading', { name: 'Synthetic employer fixture' })).toBeVisible()
    expect(employer.url()).toBe(jobFixture.url)
    await employer.close()
    await assertStillSaved()

    phase = 'manual_record'
    const recordResponse = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${job.id}/apply`) && response.request().method() === 'POST')
    await returnedDrawer.getByRole('button', { name: /Record that I submitted on the employer website|记录我已在雇主网站提交/ }).click()
    expect((await recordResponse).status()).toBe(200)
    const recorded = await finalDb.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(recorded).toMatchObject({ userId: user.id, status: 'applied', workflowState: 'submitted', finalResumeId: tailored.adaptedResumeId })
    expect(recorded.appliedAt).toBeTruthy()
    expect(await finalDb.activity.count({ where: { userId: user.id, jobId: job.id, type: 'applied', text: { startsWith: 'You applied manually ' } } })).toBe(1)
    expect(await finalDb.applyResult.count({ where: { userId: user.id, jobId: job.id } })).toBe(0)
    expect(writes.filter(value => value === `POST /api/jobs/${job.id}/apply`)).toHaveLength(1)
  } finally { await finalDb.$disconnect() }
  await context.close()
})
