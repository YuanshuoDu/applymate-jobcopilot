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
  test.setTimeout(120_000)
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'applymate-application-flow-'))
  const webRoot = path.resolve(__dirname, '../apps/web')
  const webRequire = createRequire(path.join(webRoot, 'package.json'))
  const vitestRequire = createRequire(webRequire.resolve('vitest/package.json'))
  const viteRequire = createRequire(vitestRequire.resolve('vite'))
  const { build } = viteRequire('esbuild') as { build(options: object): Promise<unknown> }
  const authPath = path.join(temporaryDirectory, 'auth.js')
  await writeFile(authPath, `import React from ${JSON.stringify(webRequire.resolve('react'))};
    const listeners=new Set();
    const update=async()=>{globalThis.__fixtureUpdateCalls=(globalThis.__fixtureUpdateCalls||0)+1;return current.data};
    let current={status:'authenticated',data:{user:{id:'fixture-user',name:'Fixture Candidate'}},update};
    globalThis.__fixtureSetSession=(status,id)=>{current={status,data:status==='authenticated'?{user:{id,name:'Fixture Candidate'}}:null,update};for(const fn of listeners)fn()};
    export function useSession(){return React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>current,()=>current)};
    export async function signOut(options){(globalThis.__fixtureSignOutCalls ||= []).push(options);return {url:'/login'}}`)
  const dynamicPath = path.join(temporaryDirectory, 'dynamic.js')
  await writeFile(dynamicPath, `import React from ${JSON.stringify(webRequire.resolve('react'))}; export default function dynamic(loader){const Component=React.lazy(()=>loader().then(value=>({default:value}))); return function Dynamic(){return React.createElement(React.Suspense,{fallback:null},React.createElement(Component))}}`)
  const navigationPath = path.join(temporaryDirectory, 'navigation.js')
  await writeFile(navigationPath, `export function useRouter(){return {push(url){(globalThis.__fixtureRouterPushes ||= []).push(url)},replace(){},refresh(){},prefetch(){}}}`)
  const unusedPagePath = path.join(temporaryDirectory, 'unused-page.js')
  await writeFile(unusedPagePath, `export const GmailPage=()=>null,JobRecommendationsPage=()=>null,AgentPlaygroundPage=()=>null,AgentHistoryPage=()=>null,SettingsPage=()=>null,ObservabilityPage=()=>null,ContactUsPage=()=>null`)

  await build({
    stdin: { contents: `
      import React, {useEffect, useState, useSyncExternalStore} from 'react';
      import {createRoot} from 'react-dom/client';
      import {AppShell} from '@/components/layout/AppShell';
      import {JobsPage} from '@/components/pages/JobsPage';
      import {ResumePage} from '@/components/pages/ResumePage';
      import {SearchPage} from '@/components/pages/SearchPage';
      import {DashboardPage} from '@/components/pages/DashboardPage';
      import {I18nProvider} from '@/lib/i18n';
      import {ToastProvider} from '@/components/ui';
      import {NavContext} from '@/lib/nav-context';
      import {getCachedApiResponse, setCachedApiResponse} from '@/lib/api-cache';
      const subscribeLocation=(cb)=>{addEventListener('popstate',cb);return()=>removeEventListener('popstate',cb)};
      function AgentDestination(){const sessionId=useSyncExternalStore(subscribeLocation,()=>new URL(location.href).searchParams.get('sessionId'),()=>null);return <div data-testid="agent-destination">{sessionId}</div>}
      function Harness(){
        const [page,setPage]=useState(new URL(location.href).searchParams.get('page')||'jobs');
        const navigate=(next)=>{const url=new URL(location.href);url.searchParams.set('page',next);history.pushState({},'',url);setPage(next)};
        useEffect(()=>{const restore=()=>setPage(new URL(location.href).searchParams.get('page')||'jobs');addEventListener('popstate',restore);return()=>removeEventListener('popstate',restore)},[]);
        return <I18nProvider><ToastProvider><NavContext.Provider value={{navigate}}>
          <nav aria-label="Fixture navigation">{['jobs','resume','search','dashboard'].map(name=><button key={name} onClick={()=>navigate(name)}>Fixture {name}</button>)}</nav>
          <main style={{display:'flex',height:'calc(100vh - 32px)',minWidth:0}}>
          {page==='jobs'?<JobsPage/>:page==='resume'?<ResumePage/>:page==='search'?<SearchPage/>:page==='dashboard'?<DashboardPage/>:<AgentDestination/>}
          </main></NavContext.Provider></ToastProvider></I18nProvider>
      }
      globalThis.__fixtureGetCachedResume = () => getCachedApiResponse('/api/resume/resume-1', 'fixture-user');
      const fixtureCachedResume = sessionStorage.getItem('fixture_cached_resume');
      if (fixtureCachedResume) setCachedApiResponse('/api/resume/resume-1', JSON.parse(fixtureCachedResume), 'fixture-user');
      createRoot(document.getElementById('root')).render(new URL(location.href).searchParams.has('shell') ? <I18nProvider><ToastProvider><AppShell/></ToastProvider></I18nProvider> : <Harness/>);
    `, loader: 'tsx', resolveDir: webRoot },
    absWorkingDir: webRoot, outfile: path.join(temporaryDirectory, 'fixture.js'), bundle: true, platform: 'browser',
    format: 'iife', jsx: 'automatic', target: 'es2022', alias: { '@': path.join(webRoot, 'src'), 'next-auth/react': authPath, 'next/dynamic': dynamicPath, 'next/navigation': navigationPath },
    plugins: [{ name: 'fixture-unused-pages', setup(build: { onResolve: (options: object, callback: () => object) => void }) { build.onResolve({ filter: /^@\/components\/pages\/(GmailPage|JobRecommendationsPage|AgentHistoryPage|SettingsPage|ObservabilityPage|ContactUsPage)$/ }, () => ({ path: unusedPagePath })) } }],
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

async function install(page: Page, options: { stale?: boolean; taskStatus?: 'unknown' | 'waiting_for_user' | 'waiting_for_authorization'; taskFailure?: boolean; missing?: boolean; holdSelectedLetter?: boolean; search?: boolean; saveMode?: 'fail' | 'hold-success' | 'hold-fail'; twoResumes?: boolean; holdResumeContent?: boolean; snapshotResumeContent?: boolean; resumeRevalidationFails?: boolean; versionedScore?: boolean; holdOldAnalysis?: boolean; auditCorrection?: boolean; holdAuditCorrection?: boolean; versions?: boolean; holdVersionRestore?: boolean; versionRestoreFails?: boolean; realAgent?: boolean } = {}) {
  let releaseVersionRestore = () => {}
  const versionRestoreGate = new Promise<void>(resolve => { releaseVersionRestore = resolve })
  let releaseAuditCorrection = () => {}
  const auditCorrectionGate = new Promise<void>(resolve => { releaseAuditCorrection = resolve })
  let releaseOldAnalysis = () => {}
  const oldAnalysisGate = new Promise<void>(resolve => { releaseOldAnalysis = resolve })
  let releaseResumeContent = () => {}
  const resumeContentGate = new Promise<void>(resolve => { releaseResumeContent = resolve })
  let releaseSave = () => {}
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
  let releaseLetters = () => {}
  const lettersGate = new Promise<void>(resolve => { releaseLetters = resolve })
  const state = { job: { ...job(), finalCoverLetterId: options.holdSelectedLetter ? 'selected-letter' : null }, resume: resume(), audit: options.auditCorrection ? { ...audit(), audit: { ...audit().audit, verdict: 'revise', findings: [{ area: 'resume', target: 'summary', severity: 'warning', title: 'Fix summary', evidence: 'Outdated wording', action: 'Apply correction', proposedValue: 'Audited v2 summary' }] } } : audit(options.stale ? '2026-10-29T10:00:00.000Z' : time),
    secondResume: { ...resume(), id: 'resume-2', name: 'Second fixture resume', targetJobId: null as string | null, content: { ...resume().content, summary: 'Second resume content.' } },
    activeUserId: 'fixture-user', requestOwners: [] as Array<{ path: string; method: string; userId: string }>, agentRequests: [] as Array<{ path: string; method: string; body?: unknown }>, writes: [] as Array<{ path: string; body: unknown }>, analysisRequests: [] as string[], analysisBodies: [] as unknown[], analysisCalls: [] as Array<{ path: string; body: unknown }>, unexpected: [] as string[], taskReads: 0, letterRequested: false, resumeContentRequested: false, releaseLetters, releaseSave, releaseResumeContent, releaseOldAnalysis, releaseAuditCorrection, releaseVersionRestore }
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname
    if (pathname.startsWith('/api/')) state.requestOwners.push({ path: pathname, method: request.method(), userId: state.activeUserId })
    if (url.origin === origin && !pathname.startsWith('/api/')) return route.continue()
    if (url.hostname === 'employer.invalid') return route.fulfill({ contentType: 'text/html', body: '<h1>Mock employer application</h1>' })
    if (url.origin !== origin) { state.unexpected.push(request.url()); return route.abort() }
    if (options.realAgent && pathname.startsWith('/api/agent/') && pathname !== '/api/agent/application-tasks') {
      const method = request.method()
      const body: unknown = method === 'POST' ? request.postDataJSON() : undefined
      state.agentRequests.push({ path: pathname, method, body })
      if (pathname === '/api/agent/roles' || pathname === '/api/agent/roles/custom') return json(route, [])
      if (pathname === '/api/agent/automations') return json(route, { automations: [] })
      if (pathname === '/api/agent/health') return json(route, { successRate: 100, captchaRate: 0, avgDurationMs: 1000, patternCacheRate: 100, last24hRuns: 1 })
      if (pathname === '/api/agent/sessions') return json(route, { sessions: [{ id: 'original-session', goal: 'Fixture application task', status: 'waiting_for_approval', updatedAt: time }], lastOpenedSessionId: 'original-session' })
      const prefix = '/api/agent/sessions/original-session'
      if (!pathname.startsWith(prefix)) { state.unexpected.push(pathname); return json(route, { error: 'Unexpected agent session' }, 404) }
      if (pathname === `${prefix}/turns`) {
        const turn = { id: 'fixture-turn', sessionId: 'original-session', source: 'automation', goal: 'Fixture application task', status: 'waiting_for_approval', revision: 1, activeStepId: null, finalItemId: null, createdAt: time, updatedAt: time, completedAt: null }
        return json(route, { turns: [turn], projection: { activeTurnId: turn.id, activeTurn: { id: turn.id, status: turn.status, revision: 1 }, queuedInputCount: 0 } })
      }
      if (pathname === `${prefix}/tasks`) return json(route, { tasks: [] })
      if (pathname === `${prefix}/timeline`) return json(route, { items: [], approvalEvents: [{ schemaVersion: 'agent-harness.v2', id: 'fixture-approval-event', sessionId: 'original-session', turnId: 'fixture-turn', itemId: null, taskId: null, type: 'approval.requested', actor: 'orchestrator', sequence: '1', payload: { approvalId: 'fixture-approval', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 1 } }] })
      if (pathname === `${prefix}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture waiting\n\n' })
      if (pathname === `${prefix}/approvals/fixture-approval` && method === 'POST') return json(route, { disposition: 'resolved' }, 202)
      if (pathname === prefix && (method === 'GET' || method === 'PATCH')) return json(route, { session: { id: 'original-session', goal: 'Fixture application task', status: 'waiting_for_approval', updatedAt: time, tasks: [], approvals: [], applicationTasks: [], questions: [], artifacts: [], qualityScore: 100 } })
      state.unexpected.push(pathname); return json(route, { error: 'Unexpected agent request' }, 404)
    }
    if (options.realAgent && pathname === '/api/me/agent-task-history-memory' && request.method() === 'GET') return json(route, { enabled: false, version: 0 })
    if (options.realAgent && pathname === '/api/agent') return json(route, { autoApply: false, requireApproval: true, isRunning: false })
    if (request.method() !== 'GET') {
      const body: unknown = request.postDataJSON()
      // Resume already runs automatic analysis on entry. Mock and account for it
      // separately; this assertion concerns material, application and submit writes.
      if (pathname === '/api/ai/score' || pathname === '/api/ai/suggest') {
        state.analysisRequests.push(pathname)
        state.analysisBodies.push(body)
        state.analysisCalls.push({ path: pathname, body })
        const summary = (body as { resumeContent?: { summary?: string } })?.resumeContent?.summary
        if (options.holdOldAnalysis && summary === 'Software engineer.') await oldAnalysisGate
        const fixtureScore = options.versionedScore && summary === 'Software engineer.' ? 21 : 82
        return json(route, pathname.endsWith('/suggest') ? { suggestions: [] } : { score: fixtureScore, matchedKeywords: ['TypeScript'], missingItems: [], sectionMatches: [], sectionScores: {}, sectionTips: {}, strengthSummary: 'Fixture match', skillsGap: [] })
      }
      state.writes.push({ path: pathname, body })
      if (pathname === '/api/resume/resume-1' && request.method() === 'PATCH' && options.saveMode) {
        if (options.saveMode === 'hold-success' || options.saveMode === 'hold-fail') { await saveGate; if (options.saveMode === 'hold-success') return json(route, { ...state.resume, ...(body as object) }) }
        return json(route, { error: 'Fixture save failed' }, 500)
      }
      if (options.versions && pathname === '/api/resume/resume-1/versions' && request.method() === 'POST') {
        if (options.holdVersionRestore) await versionRestoreGate
        state.resume = { ...state.resume, updatedAt: '2026-10-30T12:00:00.000Z', content: { ...state.resume.content, summary: 'Restored historical summary' } }
        return options.versionRestoreFails ? json(route, { error: 'Fixture uncertain restore' }, 500) : json(route, state.resume)
      }
      if (options.search && pathname === '/api/jobs' && request.method() === 'POST') return json(route, state.job)
      if (options.auditCorrection && pathname.endsWith('/audit-application/apply')) {
        if (options.holdAuditCorrection) await auditCorrectionGate
        const updatedAt = '2026-10-30T12:00:00.000Z'
        return json(route, { audit: { ...state.audit.audit, findings: [] }, target: 'summary', appliedContent: 'Audited v2 summary', resume: { ...state.resume, updatedAt, content: { ...state.resume.content, summary: 'Audited v2 summary' } }, coverLetter: null, resumeUpdatedAt: updatedAt })
      }
      if (pathname.endsWith('/audit-application')) { state.audit = audit(); return json(route, { ...state.audit.audit, resumeUpdatedAt: time }) }
      if (pathname.endsWith('/assign')) return json(route, state.job)
      if (pathname === '/api/jobs/outside-page/apply') { state.job.status = 'applied'; return json(route, state.job) }
      return json(route, { error: 'Unexpected mutation' }, 500)
    }
    if (options.search && pathname === '/api/search/unified') return json(route, { jobs: [{ id: 'search-result-1', title: state.job.role, company: state.job.company, location: state.job.location, url: state.job.url, description: '', source: 'manual', score: 82 }], meta: null })
    if (pathname === '/api/agent/application-tasks') {
      state.taskReads++
      if (options.taskFailure) return json(route, { error: 'Fixture unavailable' }, 500)
      return json(route, { tasks: options.taskStatus ? [{ id: 'task-1', userId: 'fixture-user', jobId: state.job.id, sessionId: 'original-session', status: options.taskStatus,
        checkpoint: options.taskStatus === 'unknown' ? 'submission_uncertain' : options.taskStatus === 'waiting_for_authorization' ? 'waiting_for_authorization' : 'form_answer_required', updatedAt: time, job: { company: state.job.company, role: state.job.role } }] : [] })
    }
    if (pathname === '/api/jobs') return json(route, { jobs: url.searchParams.has('finalResumeId') || url.searchParams.get('pageSize') === '30' ? [state.job] : [], total: 80, statusCounts: { saved: 80, applied: 0, interview: 0, offer: 0, rejected: 0 } })
    if (pathname === `/api/jobs/${state.job.id}`) return options.missing ? json(route, { error: 'Not found' }, 404) : json(route, state.job)
    if (pathname.endsWith('/cover-letters')) {
      if (options.holdSelectedLetter) { state.letterRequested = true; await lettersGate; return json(route, { error: 'Fixture letter unavailable' }, 500) }
      return json(route, [])
    }
    if (pathname.endsWith('/audit-application')) return json(route, state.audit)
    if (pathname === '/api/resume') return json(route, state.activeUserId === 'fixture-b' ? [{ ...state.resume, id: 'resume-b', userId: 'fixture-b', name: 'Account B resume', targetJobId: null, content: { ...state.resume.content, summary: 'Account B only' } }] : options.twoResumes ? [state.resume, state.secondResume] : [state.resume])
    if (pathname === '/api/resume/resume-b') return json(route, { ...state.resume, id: 'resume-b', userId: 'fixture-b', name: 'Account B resume', targetJobId: null, content: { ...state.resume.content, summary: 'Account B only' } })
    if (pathname === '/api/resume/resume-1' && state.activeUserId === 'fixture-b') return json(route, { error: 'Not found' }, 404)
    if (pathname === '/api/resume/resume-2') return json(route, state.secondResume)
    if (pathname === '/api/resume/resume-1' && options.holdResumeContent) { const snapshot = structuredClone(state.resume); state.resumeContentRequested = true; await resumeContentGate; return options.resumeRevalidationFails ? json(route, { error: 'Fixture revalidation failed' }, 500) : json(route, options.snapshotResumeContent ? snapshot : state.resume) }
    if (pathname === '/api/resume/resume-1' || pathname === '/api/resume/default') return json(route, state.resume)
    if (pathname === '/api/me') return json(route, { onboardedAt: time })
    if (pathname === '/api/gmail/unread') return json(route, { count: 0 })
    if (pathname === '/api/notifications') return json(route, { notifications: [], unreadCount: 0 })
    if (options.versions && pathname === '/api/resume/resume-1/versions') return json(route, [{ id: 'version-old', name: 'Historical version', createdAt: time }])
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

test('attention view opens a recent task application outside the current jobs page', async ({ page }) => {
  const state = await install(page, { taskStatus: 'waiting_for_user' })
  await page.goto(`${origin}/?page=jobs&jobsPage=3`)
  await page.getByRole('button', { name: /Needs your attention|需要我处理/ }).click()
  const attention = page.getByRole('region', { name: /Needs your attention|需要我处理/ })
  await expect(attention.getByText('Fixture Employer · Application flow engineer')).toBeVisible()
  await attention.getByRole('link', { name: /View this application|查看此申请/ }).click()
  await expect(page).toHaveURL(/highlight=outside-page/)
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
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


test('Discover saves once and opens the exact saved application', async ({ page }) => {
  const state = await install(page, { search: true })
  await page.goto(`${origin}/?page=search`)
  const search = page.getByRole('textbox', { name: /Search jobs|搜索职位/ })
  await search.fill('Fixture Engineer')
  await search.press('Enter')
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
  await page.getByTitle(/Save to My Jobs|保存到我的职位/).click()
  await expect.poll(() => state.writes.filter(item => item.path === '/api/jobs').length).toBe(1)
  const view = page.getByRole('button', { name: /View this application|查看此申请/ }).first()
  await expect(view).toBeVisible()
  await view.click()
  await expect(page).toHaveURL(/page=jobs/)
  await expect(page).toHaveURL(/highlight=outside-page/)
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
  expect(state.writes.map(item => item.path)).toEqual(['/api/jobs'])
  expect(state.unexpected).toEqual([])
})

test('opening an existing Resume analysis cache does not repeat AI requests', async ({ page }) => {
  const state = await install(page)
  await page.addInitScript(({ timestamp }) => {
    localStorage.setItem('applymate_last_analysis', JSON.stringify({
      'resume-1:outside-page': { resumeId: 'resume-1', jobId: 'outside-page', resumeUpdatedAt: timestamp,
        score: { score: 82, matchedKeywords: ['TypeScript'], missingItems: [], sectionMatches: [], sectionScores: {}, sectionTips: {}, strengthSummary: 'Fixture match', skillsGap: [] }, suggs: [] },
    }))
  }, { timestamp: time })
  await open(page)
  await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  await page.getByRole('button', { name: /Edit this resume|编辑此简历/ }).click()
  await expect(page).toHaveURL(/page=resume/)
  await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(state.analysisRequests).toEqual([])
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})


test('real AppShell mounts the selected application', async ({ page }) => {
  const state = await install(page)
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
  expect(state.unexpected).toEqual([])
})


async function openDirtyShellResume(page: Page) {
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
  await page.getByRole('dialog').getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  await page.getByRole('button', { name: /Edit this resume|编辑此简历/ }).click()
  await expect(page).toHaveURL(/page=resume/)
  await page.getByText('Software engineer.', { exact: false }).first().click()
  await page.locator('textarea').filter({ hasText: '' }).first().fill('Edited fixture summary')
}

test('real AppShell keeps the editor after a sidebar save fails', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop sidebar')
  const state = await install(page, { saveMode: 'fail' })
  await openDirtyShellResume(page)
  await page.locator('#desktop-sidebar').getByRole('button', { name: /^Applications(?:\s+\d+)?$/ }).click()
  await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
  await expect(page).toHaveURL(/page=resume/)
  await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
  expect(state.unexpected).toEqual([])
})

test('real AppShell protects browser back when saving fails', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'fail' })
  await openDirtyShellResume(page)
  await page.evaluate(() => history.back())
  await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
  await expect(page).toHaveURL(/page=resume/)
  await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
  expect(state.unexpected).toEqual([])
})

test('real Resume warns before browser reload with unsaved changes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    const dialogPromise = page.waitForEvent('dialog')
    const reload = page.reload({ waitUntil: 'commit', timeout: 2000 }).catch(() => null)
    const dialog = await dialogPromise
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    await reload
    await expect(page).toHaveURL(/page=resume/)
    await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
    expect(state.unexpected).toEqual([])
  } finally { state.releaseSave() }
})

test('real AppShell resolves two rapid navigation attempts to the latest destination', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop sidebar')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    await page.locator('#desktop-sidebar').getByRole('button', { name: /^Applications(?:\s+\d+)?$/ }).click()
    await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    await page.locator('#desktop-sidebar').getByRole('button', { name: 'Discover', exact: true }).click()
    state.releaseSave()
    await expect(page).toHaveURL(/page=search/)
    expect(state.unexpected).toEqual([])
  } finally { state.releaseSave() }
})


test('a delayed save stays bound to the original resume before switching', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume library')
  const state = await install(page, { saveMode: 'hold-success', twoResumes: true })
  try {
    await openDirtyShellResume(page)
    await page.getByText('Second fixture resume', { exact: true }).click()
    await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    await expect(page.getByText('Second resume content.', { exact: false })).toHaveCount(0)
    state.releaseSave()
    await expect(page.getByText('Second resume content.', { exact: false }).first()).toBeVisible()
    const saves = state.writes.filter(item => item.path.startsWith('/api/resume/'))
    expect(saves.map(item => item.path)).toEqual(['/api/resume/resume-1'])
    expect(JSON.stringify(saves[0].body)).toContain('Edited fixture summary')
    expect(state.unexpected).toEqual([])
  } finally { state.releaseSave() }
})

test('a failed delayed save keeps the original resume selected', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume library')
  const state = await install(page, { saveMode: 'hold-fail', twoResumes: true })
  try {
    await openDirtyShellResume(page)
    await page.getByText('Second fixture resume', { exact: true }).click()
    await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    state.releaseSave()
    await expect(page.getByText('Save failed', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Second resume content.', { exact: false })).toHaveCount(0)
    expect(state.writes.every(item => item.path === '/api/resume/resume-1')).toBe(true)
    expect(state.unexpected).toEqual([])
  } finally { state.releaseSave() }
})


test('application drawer traps keyboard focus and closes with Escape', async ({ page }) => {
  const state = await install(page)
  await open(page)
  const drawer = page.getByRole('dialog')
  const close = drawer.getByRole('button', { name: /Close application details|关闭申请详情/ })
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  expect(state.unexpected).toEqual([])
})

test('successful guarded browser back and forward restore the correct pages', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    await page.evaluate(() => history.back())
    await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    await expect(page).toHaveURL(/page=resume/)
    state.releaseSave()
    await expect(page).toHaveURL(/page=jobs/)
    await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
    await page.evaluate(() => history.forward())
    await expect(page).toHaveURL(/page=resume/)
    await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeVisible()
    expect(state.unexpected).toEqual([])
  } finally { state.releaseSave() }
})

test('cancelled unload after repeated back keeps the editor until a new navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    const dialogPromise = page.waitForEvent('dialog')
    await page.evaluate(() => { history.back(); history.back() })
    const dialog = await dialogPromise
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    await expect(page).toHaveURL(/page=resume/)
    await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
    const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/resume/resume-1') && response.request().method() === 'PATCH')
    state.releaseSave()
    await saveResponse
    await expect(page).toHaveURL(/page=resume/)
    await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
    await page.locator('#desktop-sidebar').getByRole('button', { name: 'Discover', exact: true }).click()
    await expect(page).toHaveURL(/page=search/)
    await expect(page.getByRole('textbox', { name: /Search jobs|搜索职位/ })).toBeVisible()
    expect(state.unexpected).toEqual([])
  } finally { state.releaseSave() }
})

test('accepting the browser unload warning allows the user to leave unsaved edits', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    const dialogPromise = page.waitForEvent('dialog')
    await page.evaluate(() => { history.back(); history.back() })
    const dialog = await dialogPromise
    expect(dialog.type()).toBe('beforeunload')
    await dialog.accept()
    await expect(page).toHaveURL('about:blank')
  } finally { state.releaseSave() }
})


test('late resume content starts analysis and its cache prevents a repeat on reopening', async ({ page }) => {
  const state = await install(page, { holdResumeContent: true })
  try {
    const jobsLoaded = page.waitForResponse(response => response.url().includes('/api/jobs?pageSize=30') && response.status() === 200)
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await jobsLoaded
    await expect.poll(() => state.resumeContentRequested).toBe(true)
    // Allow React to consume the completed jobs response while content remains gated.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(state.analysisRequests).toEqual([])
    state.releaseResumeContent()
    await expect.poll(() => state.analysisRequests.slice().sort()).toEqual(['/api/ai/score', '/api/ai/suggest'])
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
      return entries['resume-1:outside-page']?.score?.score
    })).toBe(82)
    await page.getByRole('button', { name: 'Fixture jobs' }).click()
    await page.getByRole('button', { name: 'Fixture resume' }).click()
    await expect(page).toHaveURL(/page=resume/)
    await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(state.analysisRequests.slice().sort()).toEqual(['/api/ai/score', '/api/ai/suggest'])
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseResumeContent() }
})


test('editing a cached resume does not automatically repeat analysis', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  await page.addInitScript(({ timestamp }) => {
    localStorage.setItem('applymate_last_analysis', JSON.stringify({
      'resume-1:outside-page': { resumeId: 'resume-1', jobId: 'outside-page', resumeUpdatedAt: timestamp,
        score: { score: 82, matchedKeywords: ['TypeScript'], missingItems: [], sectionMatches: [], sectionScores: {}, sectionTips: {}, strengthSummary: 'Fixture match', skillsGap: [] }, suggs: [] },
    }))
  }, { timestamp: time })
  try {
    await openDirtyShellResume(page)
    expect(state.analysisRequests).toEqual([])
    await page.locator('#desktop-sidebar').getByRole('button', { name: /^Applications(?:\s+\d+)?$/ }).click()
    await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    state.releaseSave()
    await expect(page).toHaveURL(/page=jobs/)
    await page.waitForLoadState('networkidle')
    expect(state.analysisRequests).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseSave() }
})


test('cached old resume revalidation never labels its analysis as the new version', async ({ page }) => {
  const state = await install(page, { holdResumeContent: true, versionedScore: true })
  const oldResume = resume()
  const newTime = '2026-10-30T12:00:00.000Z'
  state.resume.updatedAt = newTime
  state.resume.content.summary = 'Updated server resume content.'
  await page.addInitScript(cached => sessionStorage.setItem('fixture_cached_resume', JSON.stringify(cached)), oldResume)
  try {
    const jobsLoaded = page.waitForResponse(response => response.url().includes('/api/jobs?pageSize=30') && response.status() === 200)
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await jobsLoaded
    await expect.poll(() => state.resumeContentRequested).toBe(true)
    await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    // The cached content remains usable, but its stale version cannot become the new-version analysis.
    state.releaseResumeContent()
    await expect(page.getByText('Updated server resume content.', { exact: false }).first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
      return entries['resume-1:outside-page']
    })).toMatchObject({ resumeUpdatedAt: newTime, score: { score: 82 } })
    const scoreBody = state.analysisBodies.find(body => (body as { resumeContent?: { summary?: string } }).resumeContent?.summary === 'Updated server resume content.')
    expect(scoreBody).toBeDefined()
    expect(state.unexpected).toEqual([])
  } finally { state.releaseResumeContent() }
})


test('failed resume revalidation keeps cached analysis bound to the old version', async ({ page }) => {
  const state = await install(page, { holdResumeContent: true, resumeRevalidationFails: true, versionedScore: true })
  const oldResume = resume()
  state.resume.updatedAt = '2026-10-30T12:00:00.000Z'
  state.resume.content.summary = 'Updated server resume content.'
  await page.addInitScript(cached => sessionStorage.setItem('fixture_cached_resume', JSON.stringify(cached)), oldResume)
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect.poll(() => state.resumeContentRequested).toBe(true)
    await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    state.releaseResumeContent()
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
      return entries['resume-1:outside-page']
    })).toMatchObject({ resumeUpdatedAt: time, score: { score: 21 } })
    expect(state.unexpected).toEqual([])
  } finally { state.releaseResumeContent() }
})

test('A to B to A reuses in-flight analysis without misbinding results', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume library')
  const state = await install(page, { twoResumes: true, versionedScore: true, holdOldAnalysis: true })
  state.secondResume.targetJobId = 'outside-page'
  const summaryOf = (body: unknown) => (body as { resumeContent?: { summary?: string } })?.resumeContent?.summary
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect.poll(() => state.analysisCalls.filter(call => summaryOf(call.body) === 'Software engineer.').length).toBe(2)
    await page.getByText('Second fixture resume', { exact: true }).click()
    await expect(page.getByText('Second resume content.', { exact: false }).first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
      return entries['resume-2:outside-page']?.score?.score
    })).toBe(82)
    await page.locator('.resume-library-item').filter({ hasText: 'Fixture role resume' }).click()
    await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(state.analysisCalls.filter(call => summaryOf(call.body) === 'Software engineer.').length).toBe(2)
    state.releaseOldAnalysis()
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
      return entries['resume-1:outside-page']?.score?.score
    })).toBe(21)
    expect(state.analysisCalls.filter(call => summaryOf(call.body) === 'Second resume content.').map(call => call.path).sort()).toEqual(['/api/ai/score', '/api/ai/suggest'])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseOldAnalysis() }
})


test('a delayed old resume GET cannot overwrite an edit already saved', async ({ page }) => {
  const state = await install(page, { holdResumeContent: true, snapshotResumeContent: true, saveMode: 'hold-success' })
  await page.addInitScript(cached => sessionStorage.setItem('fixture_cached_resume', JSON.stringify(cached)), resume())
  const newTime = '2026-10-30T12:00:00.000Z'
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect.poll(() => state.resumeContentRequested).toBe(true)
    await page.getByText('Software engineer.', { exact: false }).first().click()
    await page.locator('textarea').first().fill('Saved while GET was pending')
    await expect.poll(() => state.writes.filter(item => item.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    state.resume.updatedAt = newTime
    const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/resume/resume-1') && response.request().method() === 'PATCH')
    state.releaseSave()
    await saveResponse
    await expect.poll(() => page.evaluate(() => {
      const read = (window as unknown as { __fixtureGetCachedResume: () => { updatedAt?: string; content?: { summary?: string } } | null }).__fixtureGetCachedResume
      return read()
    })).toMatchObject({ updatedAt: newTime, content: { summary: 'Saved while GET was pending' } })
    const oldGet = page.waitForResponse(response => response.url().endsWith('/api/resume/resume-1') && response.request().method() === 'GET')
    state.releaseResumeContent()
    await (await oldGet).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.locator('textarea').first()).toHaveValue('Saved while GET was pending')
    await expect.poll(() => page.evaluate(() => {
      const read = (window as unknown as { __fixtureGetCachedResume: () => { updatedAt?: string; content?: { summary?: string } } | null }).__fixtureGetCachedResume
      return read()
    })).toMatchObject({ updatedAt: newTime, content: { summary: 'Saved while GET was pending' } })
    expect(state.unexpected).toEqual([])
  } finally { state.releaseSave(); state.releaseResumeContent() }
})


test('A analysis finishing during B is reused when returning to A', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume library')
  const state = await install(page, { twoResumes: true, versionedScore: true, holdOldAnalysis: true })
  state.secondResume.targetJobId = 'outside-page'
  const summaryOf = (body: unknown) => (body as { resumeContent?: { summary?: string } })?.resumeContent?.summary
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect.poll(() => state.analysisCalls.filter(call => summaryOf(call.body) === 'Software engineer.').length).toBe(2)
    await page.getByText('Second fixture resume', { exact: true }).click()
    await expect(page.getByText('Second resume content.', { exact: false }).first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
      return entries['resume-2:outside-page']?.score?.score
    })).toBe(82)
    const aResponses = ['/api/ai/score', '/api/ai/suggest'].map(endpoint => page.waitForResponse(response => response.url().endsWith(endpoint) && summaryOf(response.request().postDataJSON()) === 'Software engineer.'))
    state.releaseOldAnalysis()
    await Promise.all((await Promise.all(aResponses)).map(response => response.finished()))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByText('Second resume content.', { exact: false }).first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
      return entries['resume-2:outside-page']?.score?.score
    })).toBe(82)
    await page.locator('.resume-library-item').filter({ hasText: 'Fixture role resume' }).click()
    await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')
      return entries['resume-1:outside-page']?.score?.score
    })).toBe(21)
    expect(state.analysisCalls.filter(call => summaryOf(call.body) === 'Software engineer.').length).toBe(2)
    expect(state.unexpected).toEqual([])
  } finally { state.releaseOldAnalysis() }
})


for (const pending of ['resume GET', 'analysis'] as const) {
  test(`audit correction survives an older ${pending} response`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop audit controls')
    const state = await install(page, { holdResumeContent: pending === 'resume GET', snapshotResumeContent: true, holdOldAnalysis: pending === 'analysis', versionedScore: true, auditCorrection: true })
    await page.addInitScript(cached => sessionStorage.setItem('fixture_cached_resume', JSON.stringify(cached)), resume())
    const newTime = '2026-10-30T12:00:00.000Z'
    try {
      await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
      if (pending === 'resume GET') await expect.poll(() => state.resumeContentRequested).toBe(true)
      else await expect.poll(() => state.analysisCalls.filter(call => (call.body as { resumeContent?: { summary?: string } }).resumeContent?.summary === 'Software engineer.').length).toBe(2)
      await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
      await page.getByRole('button', { name: 'Apply generated fix', exact: true }).click()
      await expect.poll(() => state.writes.map(write => write.path)).toContain('/api/jobs/outside-page/audit-application/apply')
      await expect(page.locator('[data-resume-editor]').getByText('Audited v2 summary', { exact: false }).first()).toBeVisible()
      await expect.poll(() => page.evaluate(() => {
        const read = (window as unknown as { __fixtureGetCachedResume: () => { updatedAt?: string; content?: { summary?: string } } | null }).__fixtureGetCachedResume
        return read()
      })).toMatchObject({ updatedAt: newTime, content: { summary: 'Audited v2 summary' } })
      if (pending === 'resume GET') {
        const oldGet = page.waitForResponse(response => response.url().endsWith('/api/resume/resume-1') && response.request().method() === 'GET')
        state.releaseResumeContent()
        await (await oldGet).finished()
      } else {
        const oldAnalysis = ['/api/ai/score', '/api/ai/suggest'].map(endpoint => page.waitForResponse(response => response.url().endsWith(endpoint)))
        state.releaseOldAnalysis()
        await Promise.all((await Promise.all(oldAnalysis)).map(response => response.finished()))
      }
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(page.locator('[data-resume-editor]').getByText('Audited v2 summary', { exact: false }).first()).toBeVisible()
      await expect.poll(() => page.evaluate(() => {
        const read = (window as unknown as { __fixtureGetCachedResume: () => { updatedAt?: string; content?: { summary?: string } } | null }).__fixtureGetCachedResume
        return read()
      })).toMatchObject({ updatedAt: newTime, content: { summary: 'Audited v2 summary' } })
      const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')['resume-1:outside-page'])
      expect(cache?.resumeUpdatedAt === newTime && cache?.score?.score === 21).toBe(false)
      await expect(page.getByText('21%', { exact: false })).toHaveCount(0)
      expect(state.unexpected).toEqual([])
    } finally { state.releaseResumeContent(); state.releaseOldAnalysis() }
  })
}


test('editing during audit correction is kept without overwriting the server correction', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop audit controls')
  const state = await install(page, { auditCorrection: true, holdAuditCorrection: true })
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Apply generated fix', exact: true }).click()
    await expect.poll(() => state.writes.map(write => write.path)).toContain('/api/jobs/outside-page/audit-application/apply')
    await page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first().click()
    await page.locator('[data-resume-editor] textarea').first().fill('My edit during correction')
    // The autosave debounce is two seconds; hold the correction beyond that window.
    await page.waitForTimeout(2300)
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    state.releaseAuditCorrection()
    await expect(page.getByText('Resume changed during correction', { exact: true })).toBeVisible()
    await expect(page.getByText('Your local edits were kept. Copy them, then reload and review the latest saved content before continuing.', { exact: true })).toBeVisible()
    await expect(page.locator('[data-resume-editor] textarea').first()).toHaveValue('My edit during correction')
    await page.waitForTimeout(2300)
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseAuditCorrection() }
})


test('application review opens the original real Agent session without submitting', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the real desktop Agent shell')
  const state = await install(page, { taskStatus: 'waiting_for_authorization', realAgent: true })
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  await page.getByRole('link', { name: 'Review in Agent' }).click()
  await expect(page).toHaveURL(/page=agent/)
  await expect(page).toHaveURL(/sessionId=original-session/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  await expect(page.locator('[data-agent-approval-ledger="true"]')).toBeVisible()
  await expect(page.locator('[data-agent-approval-ledger="true"] button').first()).toBeEnabled()
  expect(state.agentRequests.some(item => item.path === '/api/agent/sessions/original-session/timeline')).toBe(true)
  expect(state.agentRequests.filter(item => item.method === 'POST')).toEqual([])
  await page.locator('[data-agent-approval-ledger="true"] button').first().click()
  await expect.poll(() => state.agentRequests.filter(item => item.method === 'POST').length).toBe(1)
  expect(state.agentRequests.find(item => item.method === 'POST')).toMatchObject({ path: '/api/agent/sessions/original-session/approvals/fixture-approval', body: { expectedTurnId: 'fixture-turn', expectedRevision: 1, decision: 'approved' } })
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})


async function fixtureSession(page: Page, status: 'loading' | 'unauthenticated' | 'authenticated', userId = 'fixture-user') {
  await page.evaluate(({ status, userId }) => {
    (window as unknown as { __fixtureSetSession: (status: string, userId: string) => void }).__fixtureSetSession(status, userId)
  }, { status, userId })
}

test('a same-task edit and auth loading preserves the latest draft for its owner', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    await page.evaluate(() => {
      const input = document.querySelector('textarea') as HTMLTextAreaElement
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Last synchronous private edit')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      ;(window as unknown as { __fixtureSetSession: (status: string, userId: string) => void }).__fixtureSetSession('loading', '')
    })
    await expect(page.locator('textarea')).toHaveCount(0)
    await fixtureSession(page, 'authenticated')
    await expect(page.locator('#recovery-draft')).toHaveValue(/Last synchronous private edit/)
    const draft = JSON.parse(await page.locator('#recovery-draft').inputValue())
    expect(draft.name).toBe('Fixture role resume')
    expect(draft.content.summary).toBe('Last synchronous private edit')
    expect(draft.sectionOrder).toEqual(expect.any(Array))
    expect(draft.templateId).toBe('clean')
    expect(draft.templateOptions).toEqual(expect.any(Object))
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
  } finally { state.releaseSave() }
})

test('expired session keeps a private draft in memory and restores it only to its owner', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    await fixtureSession(page, 'unauthenticated')
    await expect(page.getByRole('link', { name: /Sign in in a new tab|在新标签登录/ })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __fixtureRouterPushes?: string[] }).__fixtureRouterPushes ?? [])).toEqual([])
    await expect(page.getByText('Edited fixture summary', { exact: false })).toHaveCount(0)
    const dialogPromise = page.waitForEvent('dialog')
    const reload = page.reload({ waitUntil: 'commit', timeout: 2000 }).catch(() => null)
    const dialog = await dialogPromise
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss(); await reload
    await fixtureSession(page, 'authenticated')
    await expect(page.locator('#recovery-draft')).toHaveValue(/Edited fixture summary/)
    const storage = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'))
    expect(storage).not.toContain('Edited fixture summary')
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
  } finally { state.releaseSave() }
})

test('switching accounts hides the previous owner draft until that owner returns', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    state.activeUserId = 'fixture-b'
    await fixtureSession(page, 'authenticated', 'fixture-b')
    await expect(page.locator('#recovery-draft')).toHaveCount(0)
    await expect(page.getByText('Edited fixture summary', { exact: false })).toHaveCount(0)
    await page.waitForTimeout(300)
    expect(state.writes.filter(write => write.path.startsWith('/api/resume/'))).toEqual([])
    state.activeUserId = 'fixture-user'
    await fixtureSession(page, 'authenticated')
    await expect(page.locator('#recovery-draft')).toHaveValue(/Edited fixture summary/)
  } finally { state.releaseSave() }
})

test('a save failure prevents desktop sign out and keeps the edited resume', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop sidebar')
  const state = await install(page, { saveMode: 'fail' })
  await openDirtyShellResume(page)
  await page.getByTitle(/Account menu|账户菜单/).click()
  await page.getByRole('menuitem', { name: /Sign Out|退出登录/ }).click()
  await expect.poll(() => state.writes.filter(write => write.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
  await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __fixtureSignOutCalls?: unknown[] }).__fixtureSignOutCalls ?? [])).toEqual([])
})

test('an in-flight save returning after account switch does not erase the original draft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    await page.locator('#desktop-sidebar').getByRole('button', { name: /^Applications(?:\s+\d+)?$/ }).click()
    await expect.poll(() => state.writes.filter(write => write.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    state.activeUserId = 'fixture-b'
    await fixtureSession(page, 'authenticated', 'fixture-b')
    state.releaseSave()
    await expect(page.getByText('Edited fixture summary', { exact: false })).toHaveCount(0)
    state.activeUserId = 'fixture-user'
    await fixtureSession(page, 'authenticated')
    await expect(page.locator('#recovery-draft')).toHaveValue(/Edited fixture summary/)
    expect(state.requestOwners.filter(request => request.path === '/api/resume/resume-1' && request.method === 'PATCH').map(request => request.userId)).toEqual(['fixture-user'])
  } finally { state.releaseSave() }
})


test('a second account can sign out while the first account draft stays private', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop sidebar')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    state.activeUserId = 'fixture-b'
    await fixtureSession(page, 'authenticated', 'fixture-b')
    await expect(page.getByTitle(/Account menu|账户菜单/)).toBeVisible()
    await expect(page.getByText('Edited fixture summary', { exact: false })).toHaveCount(0)
    await page.getByTitle(/Account menu|账户菜单/).click()
    await page.getByRole('menuitem', { name: /Sign Out|退出登录/ }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __fixtureSignOutCalls?: unknown[] }).__fixtureSignOutCalls ?? [])).toEqual([{ redirect: false }])
    await fixtureSession(page, 'unauthenticated')
    state.activeUserId = 'fixture-user'
    await fixtureSession(page, 'authenticated')
    await expect(page.locator('#recovery-draft')).toHaveValue(/Edited fixture summary/)
  } finally { state.releaseSave() }
})

test('an audit correction returning after session loss does not discard local edits', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop audit controls')
  const state = await install(page, { auditCorrection: true, holdAuditCorrection: true })
  try {
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Apply generated fix', exact: true }).click()
    await expect.poll(() => state.writes.map(write => write.path)).toContain('/api/jobs/outside-page/audit-application/apply')
    await page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first().click()
    await page.locator('[data-resume-editor] textarea').first().fill('Private edit during correction')
    await fixtureSession(page, 'unauthenticated')
    state.releaseAuditCorrection()
    await fixtureSession(page, 'authenticated')
    await expect(page.locator('#recovery-draft')).toHaveValue(/Private edit during correction/)
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
  } finally { state.releaseAuditCorrection() }
})

test('a save failure prevents mobile sign out', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-zh', 'Exercises mobile navigation')
  const state = await install(page, { saveMode: 'fail' })
  await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
  await page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first().click()
  await page.locator('[data-resume-editor] textarea').first().fill('Edited on mobile')
  await page.locator('[data-mobile-more-button]').click()
  await page.getByRole('menuitem', { name: /Sign Out|退出登录/ }).click()
  await expect.poll(() => state.writes.filter(write => write.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
  await expect(page.locator('[data-resume-editor]').getByText('Edited on mobile', { exact: false }).first()).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __fixtureSignOutCalls?: unknown[] }).__fixtureSignOutCalls ?? [])).toEqual([])
})


test('template application in the same task as auth loading is retained in the owner draft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop template picker')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: /^Templates$/ }).click()
    await page.getByText('Executive', { exact: true }).click()
    await page.getByRole('button', { name: 'Apply Template' }).evaluate(button => {
      ;(button as HTMLButtonElement).click()
      ;(window as unknown as { __fixtureSetSession: (status: string, userId: string) => void }).__fixtureSetSession('loading', '')
    })
    await expect(page.locator('[data-resume-editor]')).toHaveCount(0)
    await fixtureSession(page, 'authenticated')
    const value = page.locator('#recovery-draft')
    await expect(value).toBeVisible()
    const draft = JSON.parse(await value.inputValue())
    expect(draft.templateId).toBe('executive')
    expect(draft.templateOptions).toEqual(expect.objectContaining({ fontFamily: 'sans', density: 'comfortable' }))
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    const storage = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'))
    expect(storage).not.toContain('Fixture Candidate')
  } finally { state.releaseSave() }
})

test('section removal in the same task as auth loading is retained in the owner draft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume sections')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.locator('[data-resume-editor]').getByTitle('Remove section').first().evaluate(button => {
      ;(button as HTMLButtonElement).click()
      ;(window as unknown as { __fixtureSetSession: (status: string, userId: string) => void }).__fixtureSetSession('loading', '')
    })
    await expect(page.locator('[data-resume-editor]')).toHaveCount(0)
    await fixtureSession(page, 'authenticated')
    const value = page.locator('#recovery-draft')
    await expect(value).toBeVisible()
    const draft = JSON.parse(await value.inputValue())
    expect(draft.sectionOrder).not.toContain('summary')
    expect(draft.sectionOrder).toContain('experience')
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    const storage = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'))
    expect(storage).not.toContain('Fixture Candidate')
  } finally { state.releaseSave() }
})


test('formatting text in the same task as auth loading preserves the formatted draft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop formatting toolbar')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first().click()
    const input = page.locator('[data-resume-editor] textarea').first()
    await expect(input).toHaveValue('Software engineer.')
    await input.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(0, 8) })
    await page.getByRole('button', { name: 'Bold', exact: true }).evaluate(button => {
      ;(button as HTMLButtonElement).click()
      ;(window as unknown as { __fixtureSetSession: (status: string, userId: string) => void }).__fixtureSetSession('loading', '')
    })
    await expect(page.locator('[data-resume-editor]')).toHaveCount(0)
    await fixtureSession(page, 'authenticated')
    const draft = page.locator('#recovery-draft')
    await expect(draft).toBeVisible()
    expect(JSON.parse(await draft.inputValue()).content.summary).toBe('**Software** engineer.')
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    const storage = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'))
    expect(storage).not.toContain('**Software** engineer.')
  } finally { state.releaseSave() }
})


test('version restore does not start when saving dirty edits fails', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop version restore')
  const state = await install(page, { versions: true, saveMode: 'fail' })
  await openDirtyShellResume(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect.poll(() => state.writes.filter(write => write.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
  await expect(page.getByText(/Save failed|保存失败/).first()).toBeVisible()
  expect(state.writes.filter(write => write.path.endsWith('/versions'))).toEqual([])
  await expect(page.locator('[data-resume-editor]').getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
})

test('editing while version restore is pending keeps the edit without overwriting server result', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop version restore')
  const state = await install(page, { versions: true, holdVersionRestore: true, saveMode: 'hold-success' })
  try {
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'History', exact: true }).click()
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect.poll(() => state.writes.filter(write => write.path.endsWith('/versions')).length).toBe(1)
    const modal = page.getByText('Version History', { exact: true }).locator('..').locator('..')
    await modal.getByRole('button', { name: '✕', exact: true }).click()
    await page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first().click()
    await page.locator('[data-resume-editor] textarea').first().fill('Local edit while restore is pending')
    await page.waitForTimeout(2300)
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    state.releaseVersionRestore()
    await expect(page.getByText(/Copy them, then reload and review|请先复制/).first()).toBeVisible()
    await expect(page.locator('[data-resume-editor] textarea').first()).toHaveValue('Local edit while restore is pending')
    await page.waitForTimeout(2300)
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    expect(state.resume.content.summary).toBe('Restored historical summary')
  } finally { state.releaseVersionRestore(); state.releaseSave() }
})


test('version restore intent blocks sidebar navigation while the current edit saves', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop version restore')
  const state = await install(page, { versions: true, holdVersionRestore: true, saveMode: 'hold-success' })
  try {
    await openDirtyShellResume(page)
    await page.getByRole('button', { name: 'History', exact: true }).click()
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect.poll(() => state.writes.filter(write => write.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
    const modal = page.getByText('Version History', { exact: true }).locator('..').locator('..')
    await modal.getByRole('button', { name: '✕', exact: true }).click()
    await page.locator('#desktop-sidebar').getByRole('button', { name: 'Discover', exact: true }).click()
    await expect(page).toHaveURL(/page=resume/)
    state.releaseSave()
    await expect.poll(() => state.writes.filter(write => write.path.endsWith('/versions')).length).toBe(1)
    await expect(page).toHaveURL(/page=resume/)
    state.releaseVersionRestore()
    await expect(page.locator('[data-resume-editor]').getByText('Restored historical summary', { exact: false }).first()).toBeVisible()
    await expect(page).toHaveURL(/page=resume/)
  } finally { state.releaseVersionRestore(); state.releaseSave() }
})


test('an uncertain version restore remains guarded against automatic save or retry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop version restore')
  const state = await install(page, { versions: true, versionRestoreFails: true, saveMode: 'hold-success' })
  try {
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'History', exact: true }).click()
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect.poll(() => state.writes.filter(write => write.path.endsWith('/versions')).length).toBe(1)
    await expect(page.getByText(/Could not confirm the version was restored|无法确认版本是否已恢复/).first()).toBeVisible()
    const modal = page.getByText('Version History', { exact: true }).locator('..').locator('..')
    await modal.getByRole('button', { name: '✕', exact: true }).click()
    await page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first().click()
    await page.locator('[data-resume-editor] textarea').first().fill('Local edit after uncertain restore')
    await page.waitForTimeout(2300)
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    await page.getByRole('button', { name: 'History', exact: true }).click()
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await page.waitForTimeout(300)
    expect(state.writes.filter(write => write.path.endsWith('/versions'))).toHaveLength(1)
    await expect(page.locator('[data-resume-editor]').getByText('Local edit after uncertain restore', { exact: false }).first()).toBeVisible()
  } finally { state.releaseSave() }
})
