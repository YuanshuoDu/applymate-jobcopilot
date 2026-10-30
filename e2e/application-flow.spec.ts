import { expect, test, type Page, type Route } from '@playwright/test'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Mounted production components with mocked identity/API responses. This is not
// proof of authentication, database behavior, Agent execution or real submission.
let temporaryDirectory: string
let server: Server
let origin: string

test.beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'applymate-application-flow-'))
  const webRoot = path.resolve(__dirname, '../apps/web')
  const webRequire = createRequire(path.join(webRoot, 'package.json'))
  const vitestRequire = createRequire(webRequire.resolve('vitest/package.json'))
  const viteRequire = createRequire(vitestRequire.resolve('vite'))
  const { build } = viteRequire('esbuild') as { build(options: object): Promise<unknown> }
  const authPath = path.join(temporaryDirectory, 'auth.js')
  await writeFile(authPath, `export function useSession(){return {status:'authenticated',data:{user:{id:'fixture-user',name:'Fixture Candidate'}}}}`)
  await build({
    stdin: { contents: `
      import React, {useEffect, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {JobsPage} from '@/components/pages/JobsPage';
      import {ResumePage} from '@/components/pages/ResumePage';
      import {SearchPage} from '@/components/pages/SearchPage';
      import {DashboardPage} from '@/components/pages/DashboardPage';
      import {I18nProvider} from '@/lib/i18n';
      import {ToastProvider} from '@/components/ui';
      import {NavContext} from '@/lib/nav-context';
      function Harness(){
        const [page,setPage]=useState(new URL(location.href).searchParams.get('page')||'jobs');
        const navigate=(next)=>{const url=new URL(location.href);url.searchParams.set('page',next);history.pushState({},'',url);setPage(next)};
        useEffect(()=>{const restore=()=>setPage(new URL(location.href).searchParams.get('page')||'jobs');addEventListener('popstate',restore);return()=>removeEventListener('popstate',restore)},[]);
        return <I18nProvider><ToastProvider><NavContext.Provider value={{navigate}}>
          <nav aria-label="Fixture navigation">{['jobs','resume','search','dashboard'].map(name=><button key={name} onClick={()=>navigate(name)}>Fixture {name}</button>)}</nav>
          <main style={{display:'flex',height:'calc(100vh - 32px)',minWidth:0}}>
          {page==='jobs'?<JobsPage/>:page==='resume'?<ResumePage/>:page==='search'?<SearchPage/>:page==='dashboard'?<DashboardPage/>:<div data-testid="agent-destination">{new URL(location.href).searchParams.get('sessionId')}</div>}
          </main></NavContext.Provider></ToastProvider></I18nProvider>
      }
      createRoot(document.getElementById('root')).render(<Harness/>);
    `, loader: 'tsx', resolveDir: webRoot },
    absWorkingDir: webRoot, outfile: path.join(temporaryDirectory, 'fixture.js'), bundle: true, platform: 'browser',
    format: 'iife', jsx: 'automatic', target: 'es2022', alias: { '@': path.join(webRoot, 'src'), 'next-auth/react': authPath },
    define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent',
  })
  server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://fixture.local').pathname
      if (pathname === '/fixture.js' || pathname === '/fixture.css') {
        response.setHeader('Content-Type', pathname.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8')
        response.end(await readFile(path.join(temporaryDirectory, pathname.slice(1))))
      } else if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>:root{--bg:#fff;--bg-secondary:#f5f6fa;--bg-tertiary:#fafafa;--text:#182033;--text-muted:#64748b;--border:#ddd;--primary:#4f46e5}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}button,a{cursor:pointer}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
      } else { response.statusCode = 404; response.end('Unexpected fixture request') }
    })().catch(error => { response.statusCode = 500; response.end(String(error)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port')
  origin = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (temporaryDirectory) {
    const target = await realpath(temporaryDirectory)
    if (path.dirname(target) !== await realpath(tmpdir()) || !path.basename(target).startsWith('applymate-application-flow-')) throw new Error('Unexpected fixture cleanup path')
    await rm(target, { recursive: true, force: true })
  }
})

const time = '2026-10-30T10:00:00.000Z'
function job(id = 'outside-page') {
  return { id, userId: 'fixture-user', company: 'Fixture Employer', role: 'Application flow engineer', logo: 'FE', location: 'Dublin', status: 'saved', score: 82,
    url: 'https://employer.invalid/apply', description: 'Build TypeScript services with PostgreSQL.', salary: 'EUR 45000', source: 'manual', notes: '',
    coverLetter: null, analysisNote: null, keywords: null, appliedAt: null, followUpAt: null, workflowState: 'draft', createdAt: time, updatedAt: time,
    finalResumeId: 'resume-1', finalCoverLetterId: null }
}
function resume() {
  return { id: 'resume-1', userId: 'fixture-user', name: 'Fixture role resume', kind: 'adapted', targetJobId: 'outside-page', parentResumeId: 'base-1',
    isDefault: false, origin: 'ai', basicsDetached: false, directionId: null, createdAt: time, updatedAt: time, templateId: 'clean', templateOptions: {},
    content: { contact: { name: 'Fixture Candidate', email: 'fixture@example.invalid', location: 'Dublin' }, summary: 'Software engineer.',
      experience: [], education: [], skills: ['TypeScript'], languages: [], projects: [], certifications: [] } }
}
function audit(resumeUpdatedAt = time) {
  return { resumeId: 'resume-1', coverLetterId: null, resumeUpdatedAt,
    audit: { verdict: 'pass', summary: 'Fixture materials checked.', findings: [], matchScore: 82, source: 'independent', auditedAt: time } }
}

async function install(page: Page, options: { stale?: boolean; taskStatus?: 'unknown' | 'waiting_for_user'; taskFailure?: boolean; missing?: boolean; holdSelectedLetter?: boolean } = {}) {
  let releaseLetters = () => {}
  const lettersGate = new Promise<void>(resolve => { releaseLetters = resolve })
  const state = { job: { ...job(), finalCoverLetterId: options.holdSelectedLetter ? 'selected-letter' : null }, resume: resume(), audit: audit(options.stale ? '2026-10-29T10:00:00.000Z' : time),
    writes: [] as Array<{ path: string; body: unknown }>, analysisRequests: [] as string[], unexpected: [] as string[], taskReads: 0, letterRequested: false, releaseLetters }
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname
    if (url.origin === origin && !pathname.startsWith('/api/')) return route.continue()
    if (url.hostname === 'employer.invalid') return route.fulfill({ contentType: 'text/html', body: '<h1>Mock employer application</h1>' })
    if (url.origin !== origin) { state.unexpected.push(request.url()); return route.abort() }
    if (request.method() !== 'GET') {
      const body: unknown = request.postDataJSON()
      // Resume already runs automatic analysis on entry. Mock and account for it
      // separately; this assertion concerns material, application and submit writes.
      if (pathname === '/api/ai/score' || pathname === '/api/ai/suggest') {
        state.analysisRequests.push(pathname)
        return json(route, pathname.endsWith('/suggest') ? { suggestions: [] } : { score: 82, matchedKeywords: ['TypeScript'], missingItems: [], sectionMatches: [], sectionScores: {}, sectionTips: {}, strengthSummary: 'Fixture match', skillsGap: [] })
      }
      state.writes.push({ path: pathname, body })
      if (pathname.endsWith('/audit-application')) { state.audit = audit(); return json(route, { ...state.audit.audit, resumeUpdatedAt: time }) }
      if (pathname.endsWith('/assign')) return json(route, state.job)
      if (pathname === '/api/jobs/outside-page/apply') { state.job.status = 'applied'; return json(route, state.job) }
      return json(route, { error: 'Unexpected mutation' }, 500)
    }
    if (pathname === '/api/agent/application-tasks') {
      state.taskReads++
      if (options.taskFailure) return json(route, { error: 'Fixture unavailable' }, 500)
      return json(route, { tasks: options.taskStatus ? [{ id: 'task-1', userId: 'fixture-user', jobId: state.job.id, sessionId: 'original-session', status: options.taskStatus,
        checkpoint: options.taskStatus === 'unknown' ? 'submission_uncertain' : 'form_answer_required', updatedAt: time, job: { company: state.job.company, role: state.job.role } }] : [] })
    }
    if (pathname === '/api/jobs') return json(route, { jobs: url.searchParams.has('finalResumeId') || url.searchParams.get('pageSize') === '30' ? [state.job] : [], total: 80, statusCounts: { saved: 80, applied: 0, interview: 0, offer: 0, rejected: 0 } })
    if (pathname === `/api/jobs/${state.job.id}`) return options.missing ? json(route, { error: 'Not found' }, 404) : json(route, state.job)
    if (pathname.endsWith('/cover-letters')) {
      if (options.holdSelectedLetter) { state.letterRequested = true; await lettersGate; return json(route, { error: 'Fixture letter unavailable' }, 500) }
      return json(route, [])
    }
    if (pathname.endsWith('/audit-application')) return json(route, state.audit)
    if (pathname === '/api/resume') return json(route, [state.resume])
    if (pathname === '/api/resume/resume-1' || pathname === '/api/resume/default') return json(route, state.resume)
    if (pathname === '/api/directions' || pathname === '/api/activity' || pathname.endsWith('/versions')) return json(route, [])
    state.unexpected.push(pathname)
    return json(route, { error: 'Unhandled fixture API' }, 500)
  })
  return state
}

async function open(page: Page, query = '') {
  await page.goto(`${origin}/?page=jobs&highlight=outside-page${query}`)
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
}

test.beforeEach(async ({ page }, testInfo) => {
  page.on('pageerror', error => console.error('Mounted fixture browser error:', error.message))
  await page.addInitScript(locale => localStorage.setItem('applymate_lang', locale), testInfo.project.metadata.appLocale === 'zh' ? 'zh' : 'en')
})

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === 'passed') await page.screenshot({ path: testInfo.outputPath('mounted-success.png'), fullPage: true })
})

test('restores a highlighted job outside the current page and retains list context through the real Resume page', async ({ page }) => {
  const state = await install(page)
  await open(page, '&jobsPage=3&jobsSize=50&jobsSearch=Acme&jobsStatus=saved&jobsSort=score&jobsDirection=asc')
  await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  await page.getByRole('button', { name: /Edit this resume|编辑此简历/ }).click()
  await expect(page).toHaveURL(/page=resume/)
  await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
    return entries['resume-1:outside-page']?.score?.score
  })).toBe(82)
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page).toHaveURL(/page=jobs/)
  await expect(page).toHaveURL(/highlight=outside-page/)
  await expect(page).toHaveURL(/jobsPage=3/)
  await expect(page).toHaveURL(/jobsSize=50/)
  await expect(page).toHaveURL(/jobsSearch=Acme/)
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
  expect(state.analysisRequests.sort()).toEqual(['/api/ai/score', '/api/ai/suggest'])
  await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  await page.getByRole('button', { name: /Edit this resume|编辑此简历/ }).click()
  await expect(page).toHaveURL(/page=resume/)
  await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(state.analysisRequests.sort()).toEqual(['/api/ai/score', '/api/ai/suggest'])
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page).toHaveURL(/page=jobs/)
  await expect(page).toHaveURL(/highlight=outside-page/)
  await expect(page).toHaveURL(/jobsPage=3/)
  await expect(page).toHaveURL(/jobsSearch=Acme/)
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
  expect(state.writes).toEqual([])
  expect(state.analysisRequests.sort()).toEqual(['/api/ai/score', '/api/ai/suggest'])
  expect(state.unexpected).toEqual([])
})

test('keeps a resume-only pack ready and opens the employer without recording submission', async ({ page }) => {
  const state = await install(page)
  await open(page)
  await expect(page.getByText(/Not selected · optional|未选择 · 可选/)).toBeVisible()
  const employer = page.getByRole('button', { name: /Open employer website|前往雇主网站/, exact: true })
  await expect(employer).toBeEnabled()
  const popupPromise = page.waitForEvent('popup')
  await employer.click()
  const popup = await popupPromise
  await expect(popup.getByRole('heading', { name: 'Mock employer application' })).toBeVisible()
  expect(state.writes).toEqual([])
  expect(state.job.status).toBe('saved')
  expect(state.unexpected).toEqual([])
})

test('does not show a stale audit as ready and checks the existing resume without adding a cover letter', async ({ page }) => {
  const state = await install(page, { stale: true })
  await open(page)
  await expect(page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Open employer website|前往雇主网站/, exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual(['/api/jobs/outside-page/audit-application', '/api/jobs/outside-page/assign'])
  expect(state.writes[0].body).toEqual({ resumeId: 'resume-1', coverLetterId: null })
  expect(state.writes[1].body).toEqual({ finalResumeId: 'resume-1' })
  await expect(page.getByRole('button', { name: /Open employer website|前往雇主网站/, exact: true })).toBeEnabled()
  expect(state.unexpected).toEqual([])
})

test('unavailable task state does not expose a new preparation action', async ({ page }) => {
  const state = await install(page, { taskFailure: true })
  await open(page)
  await expect(page.getByText(/The latest task status is not available yet|暂时无法确认最新任务状态/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Prepare application materials|准备申请材料|Check current materials|检查当前材料/, exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('uncertain outcomes link to the original session without retry or submission', async ({ page }) => {
  const state = await install(page, { taskStatus: 'unknown' })
  await open(page)
  await expect(page.getByText(/Submission outcome unverified|提交结果待核实/, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Prepare application materials|准备申请材料|Check current materials|检查当前材料/, exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  await page.getByRole('link', { name: /Check the recorded outcome|核实已有结果/ }).click()
  await expect(page.getByTestId('agent-destination')).toHaveText('original-session')
  await expect(page).toHaveURL(/page=agent/)
  await expect(page).toHaveURL(/sessionId=original-session/)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('a selected cover letter that is pending or failed is never replaced with null', async ({ page }) => {
  const state = await install(page, { holdSelectedLetter: true })
  try {
    await open(page)
    await expect.poll(() => state.letterRequested).toBe(true)
    const check = page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
    await check.click()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(state.writes).toEqual([])
    const failed = page.waitForResponse(response => response.url().endsWith('/cover-letters') && response.status() === 500)
    state.releaseLetters()
    await failed
    await check.click()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(state.writes).toEqual([])
    expect(state.job.finalCoverLetterId).toBe('selected-letter')
  } finally { state.releaseLetters() }
})

test('records a manual submission only after the explicit recording action', async ({ page }) => {
  const state = await install(page)
  await open(page)
  const record = page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })
  await expect(record).toBeVisible()
  expect(state.writes).toEqual([])
  await record.click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual(['/api/jobs/outside-page/apply'])
  expect(state.job.status).toBe('applied')
  await expect(record).toHaveCount(0)
  expect(state.unexpected).toEqual([])
})
