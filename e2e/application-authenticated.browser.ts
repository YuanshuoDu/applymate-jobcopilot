import { expect, test, type Page } from '@playwright/test'

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

test('real credentials save a discovered job to the correct account', async ({ browser }) => {
  const first = await browser.newContext()
  const page = await first.newPage()
  const requests: string[] = []
  const jobReads: { path: string; status: number }[] = []
  page.on('request', request => requests.push(`${request.method()} ${new URL(request.url()).pathname}`))
  page.on('response', response => {
    const url = new URL(response.url())
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
  const second = await browser.newContext()
  const other = await second.newPage()
  await other.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await login(other, 'candidate-b@example.invalid')
  expect((await (await other.request.get('/api/jobs')).json()).jobs).toHaveLength(0)
  expect((await other.request.get(`/api/jobs/${job.id}`)).status()).toBe(404)
  await second.close()
  await first.close()
})
