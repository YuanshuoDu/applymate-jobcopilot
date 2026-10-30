import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const origin = 'http://127.0.0.1:3100'
const fixture = {
  id: 'fixture-vacancy', title: 'Fixture application engineer', company: 'Fixture Company',
  location: 'Dublin', url: 'https://employer.example.invalid/jobs/fixture-vacancy',
  description: 'Synthetic vacancy used only for an isolated authentication test.', source: 'fixture', score: 0,
}

async function login(page: Page, email: string) {
  await page.goto('/login')
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.locator('input[type="password"]').fill('Fixture-only-password-123')
  await page.getByRole('button', { name: /^(Sign in|Log in)$/ }).click()
  await page.waitForURL(url => url.pathname === '/')
  const session = await (await page.request.get('/api/auth/session')).json()
  expect(session.user.email).toBe(email)
}

test('real credentials carry a synthetic application through manual recording', async ({ browser }) => {
  const first = await browser.newContext()
  // Browser-context interception covers the popup's first request; the
  // container's internal network independently prevents outbound access.
  await first.route('**/*', route => {
    const url = route.request().url()
    if (url === fixture.url) return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Synthetic employer fixture</h1>' })
    return new URL(url).origin === origin ? route.continue() : route.abort()
  })
  const page = await first.newPage()
  const requests: string[] = []
  const jobReads: { path: string; status: number }[] = []
  const browserErrors: string[] = []
  const failedResources: { path: string; status: number }[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
  page.on('request', request => requests.push(`${request.method()} ${new URL(request.url()).pathname}`))
  page.on('response', response => {
    const url = new URL(response.url())
    if (response.status() >= 400) failedResources.push({ path: url.pathname, status: response.status() })
    if (response.request().method() === 'GET' && /^\/api\/jobs\/[^/]+$/.test(url.pathname)) {
      jobReads.push({ path: url.pathname, status: response.status() })
    }
  })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/api/search/unified') return route.fulfill({ json: { jobs: [fixture], meta: { sourcesUsed: ['fixture'], routing: 'fixture', totalRaw: 1, totalDeduped: 1, durationMs: 1 } } })
    return route.continue()
  })
  expect((await page.request.get('/api/jobs')).status()).toBe(401)
  await login(page, 'candidate-a@example.invalid')
  await page.goto('/?page=search')
  const search = page.getByRole('textbox', { name: /Search jobs|搜索职位/ })
  await search.fill('Fixture application engineer')
  await search.press('Enter')
  await expect(page.getByText(fixture.title, { exact: true }).first()).toBeVisible()
  const response = page.waitForResponse(r => r.url() === `${origin}/api/jobs` && r.request().method() === 'POST')
  const defaultResumeResponse = page.waitForResponse(r => r.url() === `${origin}/api/resume/default` && r.request().method() === 'GET')
  await page.getByTitle(/Save to My Jobs|保存到我的职位/).click()
  const savedResponse = await response
  expect(savedResponse.status()).toBe(201)
  const job = await savedResponse.json()
  expect(job).toMatchObject({ company: fixture.company, role: fixture.title, status: 'saved', workflowState: 'draft' })
  expect((await defaultResumeResponse).status()).toBe(404)
  const view = page.getByRole('button', { name: /View this application|查看此申请/ }).first()
  await expect(view).toBeVisible()
  await view.click()
  try {
    await expect(page).toHaveURL(new RegExp(`highlight=${job.id}`))
  } catch (error) {
    console.error('Fixture navigation diagnostics:', JSON.stringify({ currentUrl: page.url(), jobReads }))
    throw error
  }
  await expect(page.getByRole('dialog')).toContainText(fixture.title)
  await expect(page.getByRole('dialog')).toContainText(fixture.company)
  await page.reload()
  await expect(page.getByRole('dialog')).toContainText(fixture.title)
  await expect(page.getByRole('dialog')).toContainText(fixture.company)
  const jobs = await (await page.request.get('/api/jobs')).json()
  expect(jobs.jobs.filter((item: { id: string }) => item.id === job.id)).toHaveLength(1)
  expect(requests.filter(value => value === 'POST /api/jobs')).toHaveLength(1)
  // This observes requests made by this page, not possible server-side calls.
  expect(requests.filter(value => value === 'POST /api/ai/score')).toHaveLength(0)
  expect(requests.filter(value => value === `POST /api/jobs/${job.id}/apply`)).toHaveLength(0)

  // Create a synthetic original after discovery, so discovery does not run AI scoring.
  // The source data and the subsequent audit record are fixture data, not a real audit.
  const created = await page.request.post('/api/resume', { data: {
    name: 'Synthetic fixture resume', isDefault: true, kind: 'base', origin: 'manual',
    content: { contact: { name: 'Fixture Candidate', email: 'candidate-a@example.invalid', location: 'Dublin' },
      summary: 'Synthetic original summary.', experience: [], education: [], skills: ['TypeScript'], languages: [], projects: [], certifications: [] },
  } })
  expect(created.status()).toBe(201)
  const syntheticResume = await created.json()
  const linked = await page.request.patch(`/api/resume/${syntheticResume.id}`, { data: { targetJobId: job.id } })
  expect(linked.status()).toBe(200)
  expect(await linked.json()).toMatchObject({ id: syntheticResume.id, targetJobId: job.id })
  await page.goto(`/?page=resume&resumeId=${syntheticResume.id}&returnToJobs=1&returnJobId=${job.id}`)
  const editor = page.locator('[data-resume-editor]')
  await editor.getByText('Synthetic original summary.', { exact: false }).first().click()
  const save = page.waitForResponse(response => response.url().endsWith(`/api/resume/${syntheticResume.id}`) && response.request().method() === 'PATCH')
  await editor.locator('textarea').first().fill('Synthetic edited summary.')
  const saved = await save
  expect(saved.status()).toBe(200)
  expect(await saved.json()).toMatchObject({ id: syntheticResume.id, content: { summary: 'Synthetic edited summary.' } })
  await expect(page.locator('.resume-top-save')).toContainText(/Saved just now|刚刚保存/)

  const requireFixture = createRequire(path.resolve('e2e/application-authenticated.browser.ts'))
  const { seedSyntheticAudit, assertManualState, closeFixtureDb } = requireFixture('./application-authenticated-audit.cjs') as {
    seedSyntheticAudit: (jobId: string, resumeId: string) => Promise<void>
    assertManualState: (jobId: string, resumeId: string, status: 'saved' | 'applied') => Promise<void>
    closeFixtureDb: () => Promise<void>
  }
  try {
    await seedSyntheticAudit(job.id, syntheticResume.id)
    await page.reload()
    await expect(editor.getByText('Synthetic edited summary.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
    await expect(confirmation).toContainText('Synthetic fixture audit; no AI auditor was run.')
    const assign = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${job.id}/assign`) && response.request().method() === 'PATCH')
    await confirmation.getByRole('button', { name: /Confirm application package|确认申请包/, exact: true }).click()
    expect((await assign).status()).toBe(200)
    await expect(page).toHaveURL(new RegExp(`highlight=${job.id}`))
    const drawer = page.getByRole('dialog')
    await expect(drawer).toContainText(fixture.title)
    await assertManualState(job.id, syntheticResume.id, 'saved')

    await page.evaluate(() => {
      const fixtureWindow = window as unknown as { downloadNotices: string[] }
      fixtureWindow.downloadNotices = []
      new MutationObserver(() => {
        const text = document.body.innerText
        for (const notice of ['Could not download application materials', 'Some characters cannot be included in the PDF', 'Application materials download started']) {
          if (text.includes(notice) && !fixtureWindow.downloadNotices.includes(notice)) fixtureWindow.downloadNotices.push(notice)
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    const downloadRequestStart = requests.length
    let file
    try {
      const download = page.waitForEvent('download', { timeout: 30_000 })
      await drawer.getByRole('button', { name: /Download application materials|下载申请材料/ }).click()
      file = await download
    } catch (error) {
      console.error('Fixture download diagnostics:', JSON.stringify({ browserErrors, failedResources,
        requests: requests.slice(downloadRequestStart), notices: await page.evaluate(() => (window as unknown as { downloadNotices: string[] }).downloadNotices) }))
      throw error
    }
    const archivePath = await file.path()
    if (!archivePath) throw new Error('Browser did not provide the ZIP file')
    const requireWeb = createRequire(path.resolve('apps/web/package.json'))
    const JSZip = requireWeb('jszip') as { loadAsync: (bytes: Buffer) => Promise<{ files: Record<string, { dir: boolean; async: (type: 'string' | 'nodebuffer') => Promise<string | Buffer> }> }> }
    const archive = await JSZip.loadAsync(await readFile(archivePath))
    const names = Object.keys(archive.files).filter(name => !archive.files[name].dir)
    const metaName = names.find(name => name.endsWith('meta.json'))
    const pdfName = names.find(name => name.toLowerCase().endsWith('.pdf'))
    expect(metaName).toBeTruthy()
    expect(pdfName).toBeTruthy()
    expect(names.filter(name => name.toLowerCase().endsWith('.pdf'))).toHaveLength(1)
    const metadata = JSON.parse(await archive.files[metaName!].async('string') as string)
    expect(metadata).toMatchObject({ company: fixture.company, role: fixture.title, jobUrl: fixture.url, resume: { id: syntheticResume.id }, coverLetter: null, appliedAt: null })
    const pdfBytes = await archive.files[pdfName!].async('nodebuffer') as Buffer
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
    const parsePdf = requireWeb('pdf-parse') as (bytes: Uint8Array) => Promise<{ text: string }>
    expect((await parsePdf(Uint8Array.from(pdfBytes))).text).toMatch(/Synthetic\s+edited\s+summary\./)
    await assertManualState(job.id, syntheticResume.id, 'saved')

    const popup = first.waitForEvent('page')
    await drawer.getByRole('button', { name: /Open employer website|前往雇主网站/, exact: true }).click()
    const employer = await popup
    await expect(employer.getByRole('heading', { name: 'Synthetic employer fixture' })).toBeVisible()
    expect(employer.url()).toBe(fixture.url)
    await employer.close()
    await assertManualState(job.id, syntheticResume.id, 'saved')

    const manual = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${job.id}/apply`) && response.request().method() === 'POST')
    await drawer.getByRole('button', { name: /Record that I submitted on the employer website|记录我已在雇主网站提交/ }).click()
    expect((await manual).status()).toBe(200)
    await assertManualState(job.id, syntheticResume.id, 'applied')
    expect(requests.filter(value => value === `POST /api/jobs/${job.id}/apply`)).toHaveLength(1)
    expect(requests.filter(value => value === 'POST /api/ai/score')).toHaveLength(0)
    expect(requests.filter(value => value === `POST /api/jobs/${job.id}/audit-application`)).toHaveLength(0)
  } finally { await closeFixtureDb() }
  const second = await browser.newContext()
  const other = await second.newPage()
  await other.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await login(other, 'candidate-b@example.invalid')
  expect((await (await other.request.get('/api/jobs')).json()).jobs).toHaveLength(0)
  expect((await other.request.get(`/api/jobs/${job.id}`)).status()).toBe(404)
  await second.close()
  await first.close()
})
