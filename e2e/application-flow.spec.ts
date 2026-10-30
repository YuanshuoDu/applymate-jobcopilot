import { expect, test, type Page, type Route } from '@playwright/test'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
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
      } else if (pathname === '/fonts/NotoSans-Regular.ttf' || pathname === '/fonts/NotoSansSC-GB2312-Regular.ttf') {
        response.setHeader('Content-Type', 'font/ttf')
        response.end(await readFile(path.join(webRoot, 'public', pathname.slice(1))))
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

async function install(page: Page, options: { stale?: boolean; taskStatus?: 'unknown' | 'waiting_for_user' | 'waiting_for_authorization' | 'cancelled' | 'failed' | 'filling'; recordedInitially?: boolean; evidenceCase?: 'bound' | 'unbound' | 'unavailable'; taskFailure?: boolean; missing?: boolean; holdSelectedLetter?: boolean; selectedLetter?: boolean; firstPreparation?: boolean; failFirstAudit?: boolean; flowSave?: boolean; manualOutcome?: 'get-fails' | 'unknown'; search?: boolean; saveMode?: 'fail' | 'hold-success' | 'hold-fail'; twoResumes?: boolean; holdResumeContent?: boolean; snapshotResumeContent?: boolean; resumeRevalidationFails?: boolean; versionedScore?: boolean; holdOldAnalysis?: boolean; holdFirstAnalysisOnly?: boolean; auditCorrection?: boolean; holdAuditCorrection?: boolean; versions?: boolean; holdVersionRestore?: boolean; versionRestoreFails?: boolean; realAgent?: boolean; agentJourney?: boolean } = {}) {
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
  const state = { job: { ...job(), finalCoverLetterId: options.holdSelectedLetter || options.selectedLetter ? 'selected-letter' : null, finalResumeId: options.firstPreparation ? null : 'resume-1' }, resume: resume(), audit: options.auditCorrection ? { ...audit(), audit: { ...audit().audit, verdict: 'revise', findings: [{ area: 'resume', target: 'summary', severity: 'warning', title: 'Fix summary', evidence: 'Outdated wording', action: 'Apply correction', proposedValue: 'Audited v2 summary' }] } } : audit(options.stale ? '2026-10-29T10:00:00.000Z' : time),
    secondResume: { ...resume(), id: 'resume-2', name: 'Second fixture resume', targetJobId: null as string | null, content: { ...resume().content, summary: 'Second resume content.' } },
    manualPosted: false, manualReadAvailable: false, hideResumeOnExport: false, fontRequests: [] as string[], activeUserId: 'fixture-user', agentStage: 'question' as 'question' | 'approval' | 'running' | 'unknown', requestOwners: [] as Array<{ path: string; method: string; userId: string }>, agentRequests: [] as Array<{ path: string; method: string; body?: unknown }>, writes: [] as Array<{ path: string; body: unknown }>, analysisRequests: [] as string[], analysisBodies: [] as unknown[], analysisCalls: [] as Array<{ path: string; body: unknown }>, unexpected: [] as string[], taskReads: 0, letterRequested: false, resumeContentRequested: false, releaseLetters, releaseSave, releaseResumeContent, releaseOldAnalysis, releaseAuditCorrection, releaseVersionRestore }
  if (options.evidenceCase === 'unbound') state.job.finalResumeId = null
  if (options.evidenceCase === 'unavailable') state.hideResumeOnExport = true
  if (options.recordedInitially) state.job = { ...state.job, status: 'applied', workflowState: 'submitted' }
  if (options.selectedLetter) state.audit = { ...state.audit, coverLetterId: 'selected-letter', coverLetterUpdatedAt: time }
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname
    if (pathname.startsWith('/api/')) state.requestOwners.push({ path: pathname, method: request.method(), userId: state.activeUserId })
    if (url.origin === origin && pathname.startsWith('/fonts/')) state.fontRequests.push(pathname)
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
      if (options.agentJourney && pathname.startsWith(prefix)) {
        const stage = state.agentStage
        const statuses = { question: 'waiting_for_user', approval: 'waiting_for_approval', running: 'in_progress', unknown: 'completed' } as const
        const revisions = { question: 1, approval: 2, running: 3, unknown: 4 } as const
        const status = statuses[stage], revision = revisions[stage]
        if (pathname === `${prefix}/turns` && method === 'GET') {
          const turn = { id: 'fixture-turn', sessionId: 'original-session', source: 'automation', goal: 'Fixture application task', status, revision, activeStepId: null, finalItemId: null, createdAt: time, updatedAt: time, completedAt: null }
          return json(route, { turns: [turn], projection: { activeTurnId: stage === 'unknown' ? null : turn.id, activeTurn: stage === 'unknown' ? null : { id: turn.id, status, revision, goal: turn.goal }, queuedInputCount: 0 } })
        }
        if (pathname === `${prefix}/tasks` && method === 'GET') return json(route, { tasks: [] })
        if (pathname === `${prefix}/timeline` && method === 'GET') {
          const question = { schemaVersion: 'agent-harness.v2', id: 'fixture-question-item', sessionId: 'original-session', turnId: 'fixture-turn', stepId: null, taskId: null, type: 'question', status: 'started', phase: 'commentary', revision: 0, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, sequence: '1', content: { waitKind: 'question', questionId: 'fixture-question', stage: 'profile', question: 'Confirm the fixture fact?', options: [{ value: 'yes', label: 'Yes' }], answerAvailable: false, pending: true } }
          const approval = { schemaVersion: 'agent-harness.v2', id: 'fixture-approval-event', sessionId: 'original-session', turnId: 'fixture-turn', itemId: null, taskId: null, type: 'approval.requested', actor: 'orchestrator', sequence: '2', payload: { approvalId: 'fixture-approval', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 1 } }
          const result = { schemaVersion: 'agent-harness.v2', id: 'fixture-result', sessionId: 'original-session', turnId: 'fixture-turn', stepId: null, taskId: null, type: 'agent_message', status: 'completed', phase: 'final_answer', revision: 1, startedAt: time, completedAt: time, createdAt: time, updatedAt: time, sequence: '3', content: { text: 'Fixture outcome is unverified. Check the original records.' } }
          return json(route, { items: stage === 'question' ? [question] : stage === 'unknown' ? [result] : [], approvalEvents: stage === 'approval' ? [approval] : [] })
        }
        if (pathname === `${prefix}/events` && method === 'GET') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture waiting\n\n' })
        if (pathname === `${prefix}/questions/fixture-question` && method === 'POST' && stage === 'question') { state.agentStage = 'approval'; return json(route, { disposition: 'resolved' }, 202) }
        if (pathname === `${prefix}/approvals/fixture-approval` && method === 'POST' && stage === 'approval') { state.agentStage = 'running'; return json(route, { disposition: 'resolved' }, 202) }
        if (pathname === prefix && (method === 'GET' || method === 'PATCH')) return json(route, { session: { id: 'original-session', goal: 'Fixture application task', status, updatedAt: time, tasks: [], approvals: [], applicationTasks: [], questions: [], artifacts: [], qualityScore: 100 } })
        state.unexpected.push(`${method} ${pathname}`); return json(route, { error: 'Unexpected agent journey request' }, 404)
      }
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
      // Account for explicit analysis separately from application and submit writes.
      if (pathname === '/api/ai/score' || pathname === '/api/ai/suggest') {
        state.analysisRequests.push(pathname)
        state.analysisBodies.push(body)
        state.analysisCalls.push({ path: pathname, body })
        const summary = (body as { resumeContent?: { summary?: string } })?.resumeContent?.summary
        const matchingCalls = state.analysisCalls.filter(call => call.path === pathname && (call.body as { resumeContent?: { summary?: string } }).resumeContent?.summary === summary).length
        if (summary === 'Software engineer.' && (options.holdOldAnalysis || (options.holdFirstAnalysisOnly && matchingCalls === 1))) await oldAnalysisGate
        const fixtureScore = options.holdFirstAnalysisOnly && summary === 'Software engineer.' ? (matchingCalls === 1 ? 21 : 82) : options.versionedScore && summary === 'Software engineer.' ? 21 : 82
        return json(route, pathname.endsWith('/suggest') ? { suggestions: [] } : { score: fixtureScore, matchedKeywords: ['TypeScript'], missingItems: [], sectionMatches: [], sectionScores: {}, sectionTips: {}, strengthSummary: 'Fixture match', skillsGap: [] })
      }
      state.writes.push({ path: pathname, body })
      if (pathname === '/api/resume/resume-1' && request.method() === 'PATCH' && options.flowSave) { state.resume = { ...state.resume, ...(body as object), updatedAt: '2026-10-30T12:00:00.000Z' }; return json(route, state.resume) }
      if (pathname === '/api/resume/resume-1' && request.method() === 'PATCH' && options.saveMode) {
        if (options.saveMode === 'hold-success' || options.saveMode === 'hold-fail') { await saveGate; if (options.saveMode === 'hold-success') return json(route, { ...state.resume, ...(body as object) }) }
        return json(route, { error: 'Fixture save failed' }, 500)
      }
      if (pathname === '/api/resume/resume-2' && request.method() === 'PATCH' && options.saveMode === 'hold-success') { await saveGate; return json(route, { ...state.secondResume, ...(body as object) }) }
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
      if (pathname.endsWith('/tailor-resume')) return json(route, { adaptedResumeId: 'resume-1' })
      if (pathname.endsWith('/audit-application')) { if (options.failFirstAudit && state.writes.filter(write => write.path.endsWith('/audit-application')).length === 1) return json(route, { error: 'Fixture audit unavailable' }, 500); const letterId = (body as { coverLetterId: string | null }).coverLetterId; state.audit = { ...audit(state.resume.updatedAt), coverLetterId: letterId, ...(letterId ? { coverLetterUpdatedAt: time } : {}) }; return json(route, { ...state.audit.audit, resumeUpdatedAt: state.resume.updatedAt, ...(letterId ? { coverLetterUpdatedAt: time } : {}) }) }
      if (pathname.endsWith('/assign')) { Object.assign(state.job, body); return json(route, state.job) }
      if (pathname === '/api/jobs/outside-page/apply') { state.manualPosted = true; if (options.manualOutcome === 'unknown') return route.abort('failed'); state.job.status = 'applied'; return json(route, state.job) }
      return json(route, { error: 'Unexpected mutation' }, 500)
    }
    if (options.search && pathname === '/api/search/unified') return json(route, { jobs: [{ id: 'search-result-1', title: state.job.role, company: state.job.company, location: state.job.location, url: state.job.url, description: '', source: 'manual', score: 82 }], meta: null })
    if (pathname === '/api/agent/application-tasks') {
      state.taskReads++
      if (options.taskFailure) return json(route, { error: 'Fixture unavailable' }, 500)
      const currentTaskStatus = options.agentJourney ? ({ question: 'waiting_for_user', approval: 'waiting_for_authorization', running: 'filling', unknown: 'unknown' } as const)[state.agentStage] : options.taskStatus
      return json(route, { tasks: currentTaskStatus ? [{ id: 'task-1', userId: 'fixture-user', jobId: state.job.id, sessionId: 'original-session', status: currentTaskStatus,
        checkpoint: currentTaskStatus === 'unknown' ? 'submission_uncertain' : currentTaskStatus === 'waiting_for_user' ? 'form_answer_required' : currentTaskStatus === 'cancelled' || currentTaskStatus === 'failed' ? 'turn_stopped_before_submit' : null, updatedAt: time, job: { company: state.job.company, role: state.job.role } }] : [] })
    }
    if (pathname === '/api/jobs') return json(route, { jobs: url.searchParams.has('finalResumeId') || url.searchParams.get('pageSize') === '30' ? [state.job] : [], total: 80, statusCounts: { saved: 80, applied: 0, interview: 0, offer: 0, rejected: 0 } })
    if (pathname === `/api/jobs/${state.job.id}` && state.manualPosted && options.manualOutcome === 'get-fails' && !state.manualReadAvailable) return json(route, { error: 'Fixture read unavailable' }, 500)
    if (pathname === `/api/jobs/${state.job.id}` && state.manualPosted && options.manualOutcome === 'get-fails' && state.manualReadAvailable) return json(route, { ...state.job, status: 'saved' })
    if (pathname === `/api/jobs/${state.job.id}`) return options.missing ? json(route, { error: 'Not found' }, 404) : json(route, state.job)
    if (pathname.endsWith('/cover-letters')) {
      if (options.holdSelectedLetter) { state.letterRequested = true; await lettersGate; return json(route, { error: 'Fixture letter unavailable' }, 500) }
      return json(route, options.selectedLetter ? [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'I am excited to contribute my TypeScript experience.', tone: 'professional', createdAt: time, updatedAt: time }] : [])
    }
    if (pathname.endsWith('/audit-application') && options.evidenceCase) return json(route, { ...audit(), audit: { ...audit().audit, verdict: 'needs_review', findings: [{ area: 'resume', severity: 'warning', resolution: 'evidence_needed', target: 'summary', title: 'Fixture evidence', evidence: 'No independent support', action: 'Review the claim' }] } })
    if (pathname.endsWith('/audit-application')) return json(route, options.firstPreparation && !state.writes.some(write => write.path.endsWith('/audit-application')) ? null : state.audit)
    if (pathname === '/api/resume' && options.firstPreparation) return json(route, [{ ...state.resume, id: 'base-1', kind: 'base', targetJobId: null, isDefault: true }])
    if (pathname === '/api/resume') return json(route, state.activeUserId === 'fixture-b' ? [{ ...state.resume, id: 'resume-b', userId: 'fixture-b', name: 'Account B resume', targetJobId: null, content: { ...state.resume.content, summary: 'Account B only' } }] : options.twoResumes ? [state.resume, state.secondResume] : [state.resume])
    if (pathname === '/api/resume/resume-b') return json(route, { ...state.resume, id: 'resume-b', userId: 'fixture-b', name: 'Account B resume', targetJobId: null, content: { ...state.resume.content, summary: 'Account B only' } })
    if (pathname === '/api/resume/resume-1' && state.activeUserId === 'fixture-b') return json(route, { error: 'Not found' }, 404)
    if (pathname === '/api/resume/resume-2') return json(route, state.secondResume)
    if (pathname === '/api/resume/resume-1' && options.holdResumeContent) { const snapshot = structuredClone(state.resume); state.resumeContentRequested = true; await resumeContentGate; return options.resumeRevalidationFails ? json(route, { error: 'Fixture revalidation failed' }, 500) : json(route, options.snapshotResumeContent ? snapshot : state.resume) }
    if (pathname === '/api/resume/resume-1' && state.hideResumeOnExport) return json(route, { error: 'Fixture material unavailable' }, 404)
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
  await page.waitForLoadState('networkidle')
  expect(state.analysisRequests).toEqual([])
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page).toHaveURL(/page=jobs/)
  await expect(page).toHaveURL(/highlight=outside-page/)
  await expect(page).toHaveURL(/jobsPage=3/)
  await expect(page).toHaveURL(/jobsSize=50/)
  await expect(page).toHaveURL(/jobsSearch=Acme/)
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
  expect(state.analysisRequests).toEqual([])
  await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  await page.getByRole('button', { name: /Edit this resume|编辑此简历/ }).click()
  await expect(page).toHaveURL(/page=resume/)
  await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(state.analysisRequests).toEqual([])
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page).toHaveURL(/page=jobs/)
  await expect(page).toHaveURL(/highlight=outside-page/)
  await expect(page).toHaveURL(/jobsPage=3/)
  await expect(page).toHaveURL(/jobsSearch=Acme/)
  await expect(page.getByText('Application flow engineer', { exact: true }).first()).toBeVisible()
  expect(state.writes).toEqual([])
  expect(state.analysisRequests).toEqual([])
  expect(state.unexpected).toEqual([])
})


test('confirmed resume opens the same application without local export', async ({ page }) => {
  const state = await install(page)
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page&jobsSearch=Fixture`)
  await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
  await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
  await expect(dialog.getByText('Application flow engineer', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: /View this application|查看此申请/, exact: true }).click()
  await expect(page).toHaveURL(/page=jobs/)
  await expect(page).toHaveURL(/highlight=outside-page/)
  await expect(page).toHaveURL(/jobsSearch=Fixture/)
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  expect(state.requestOwners.filter(request => request.path.endsWith('/export-local'))).toEqual([])
  expect(state.writes).toEqual([])
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



for (const status of ['cancelled', 'failed'] as const) {
  test(`manual record is reflected in submission progress after ${status} before submit`, async ({ page }) => {
    const state = await install(page, { taskStatus: status })
    await open(page)
    const progress = page.getByRole('list', { name: /Application progress|申请进度/ })
    const submission = progress.locator('li').filter({ hasText: /Submission record|提交记录/ })
    await expect(submission).toContainText(/Not confirmed|尚未确认/)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    await expect.poll(() => state.writes.filter(write => write.path.endsWith('/apply')).length).toBe(1)
    await expect(page.getByText(/This application has a recorded result|此申请已有结果记录/).first()).toBeVisible()
    await expect(submission).toContainText(/Recorded|已有记录/)
    expect(state.unexpected).toEqual([])
  })
}

for (const status of ['unknown', 'filling'] as const) {
  test(`an existing record does not mark ${status} task submission confirmed`, async ({ page }) => {
    const state = await install(page, { taskStatus: status, recordedInitially: true })
    await open(page)
    const submission = page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Submission record|提交记录/ })
    await expect(submission).toContainText(/Not confirmed|尚未确认/)
    await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

for (const evidenceCase of ['bound', 'unbound', 'unavailable'] as const) {
  test(`application evidence guidance uses only the current resume: ${evidenceCase}`, async ({ page }) => {
    const state = await install(page, { evidenceCase })
    await open(page)
    await page.getByRole('button', { name: /Provide missing information|补充信息/, exact: true }).click()
    const card = page.getByText(/Fixture evidence/).locator('..')
    await expect(card).toContainText(/Evidence for this application cannot yet be saved separately|目前无法单独保存此申请的新增证据/)
    await expect(card).toContainText('No independent support')
    const edit = card.getByRole('button', { name: /Edit this resume|编辑此简历/ })
    if (evidenceCase === 'unavailable') {
      await expect(card).toContainText(/The application resume is unavailable or still loading|申请简历不可用或仍在加载/)
      await expect(edit).toBeDisabled()
    } else {
      await expect(edit).toBeEnabled()
      await edit.click()
      await expect(page).toHaveURL(/page=resume/)
      await expect(page).toHaveURL(/resumeId=resume-1/)
    }
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('first preparation audits only the resume without generating or binding a cover letter', async ({ page }) => {
  const state = await install(page, { firstPreparation: true })
  await open(page)
  await page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true }).click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual([
    '/api/jobs/outside-page/tailor-resume', '/api/jobs/outside-page/audit-application', '/api/jobs/outside-page/assign',
  ])
  expect(state.writes[1].body).toEqual({ resumeId: 'resume-1', coverLetterId: null })
  expect(state.writes[2].body).toEqual({ finalResumeId: 'resume-1' })
  expect(state.job.finalCoverLetterId).toBeNull()
  expect(state.unexpected).toEqual([])
})


test('retrying preparation after the first audit fails reuses the generated resume', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, failFirstAudit: true })
  await open(page)
  const prepare = page.getByRole('button', { name: /Prepare application materials|准备申请材料|Check current materials|检查当前材料/, exact: true })
  await prepare.click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual([
    '/api/jobs/outside-page/tailor-resume', '/api/jobs/outside-page/audit-application',
  ])
  await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
  expect(state.writes[1].body).toEqual({ resumeId: 'resume-1', coverLetterId: null })
  expect(state.job.finalResumeId).toBeNull()
  await expect(prepare).toBeEnabled()
  await prepare.click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual([
    '/api/jobs/outside-page/tailor-resume', '/api/jobs/outside-page/audit-application',
    '/api/jobs/outside-page/audit-application', '/api/jobs/outside-page/assign',
  ])
  expect(state.writes[2].body).toEqual({ resumeId: 'resume-1', coverLetterId: null })
  expect(state.writes[3].body).toEqual({ finalResumeId: 'resume-1' })
  expect(state.job.finalResumeId).toBe('resume-1')
  expect(state.unexpected).toEqual([])
})

test('checking an already selected letter preserves its binding', async ({ page }) => {
  const state = await install(page, { selectedLetter: true, stale: true })
  await open(page)
  await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual(['/api/jobs/outside-page/audit-application', '/api/jobs/outside-page/assign'])
  expect(state.writes[0].body).toEqual({ resumeId: 'resume-1', coverLetterId: 'selected-letter' })
  expect(state.writes[1].body).toEqual({ finalResumeId: 'resume-1' })
  expect(state.job.finalCoverLetterId).toBe('selected-letter')
  expect(state.unexpected).toEqual([])
})

for (const outcome of ['get-fails', 'unknown'] as const) {
  test(`manual recording ${outcome} remains locked across status checks and reload`, async ({ page }) => {
    const state = await install(page, { manualOutcome: outcome })
    await open(page)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    await expect.poll(() => state.writes.filter(write => write.path.endsWith('/apply')).length).toBe(1)
    const refresh = page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
    await expect(refresh).toBeVisible()
    await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    await refresh.click()
    await expect(page.getByText(/still unconfirmed|仍无法确认记录状态/)).toBeVisible()
    state.manualReadAvailable = true
    await page.reload()
    await expect(page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  })
}


async function pdfText(bytes: Buffer): Promise<string> {
  const webRequire = createRequire(path.resolve(__dirname, '../apps/web/package.json'))
  const parser = webRequire.resolve('pdf-parse')
  return new Promise((resolve, reject) => {
    const script = `const parse=require(process.argv[1]);const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{const raw=Buffer.concat(chunks);const exact=Buffer.alloc(raw.length);raw.copy(exact);parse(exact).then(result=>process.stdout.write(result.text)).catch(error=>{console.error(error);process.exitCode=1})})`
    const child = spawn(process.execPath, ['-e', script, parser], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errorOutput = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { errorOutput += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(errorOutput)))
    child.stdin.end(bytes)
  })
}

async function expectApplicationZip(page: Page, selectedLetter: boolean, expectedResumeText = 'Fixture Candidate') {
  const downloadButton = page.getByRole('button', { name: /Download application materials|下载申请材料/ })
  await expect(downloadButton).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await downloadButton.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  const file = await download.path()
  expect(file).toBeTruthy()
  const webRequire = createRequire(path.resolve(__dirname, '../apps/web/package.json'))
  const JSZip = webRequire('jszip')
  const archive = await JSZip.loadAsync(await readFile(file!))
  const names: string[] = Object.keys(archive.files).filter(name => !archive.files[name].dir).sort()
  expect(names).toEqual([
    ...(selectedLetter ? ['Fixture Employer/Application flow engineer/CoverLetter.pdf'] : []),
    'Fixture Employer/Application flow engineer/Resume.pdf',
    'Fixture Employer/Application flow engineer/meta.json',
  ])
  const meta = JSON.parse(await archive.file('Fixture Employer/Application flow engineer/meta.json').async('string'))
  expect(meta.resume.id).toBe('resume-1')
  expect(meta.coverLetter?.id ?? null).toBe(selectedLetter ? 'selected-letter' : null)
  const pdfBytes = await archive.file('Fixture Employer/Application flow engineer/Resume.pdf').async('nodebuffer')
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(await pdfText(pdfBytes)).toContain(expectedResumeText)
  if (selectedLetter) {
    const letterBytes = await archive.file('Fixture Employer/Application flow engineer/CoverLetter.pdf').async('nodebuffer')
    expect(letterBytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(await pdfText(letterBytes)).toContain('TypeScript')
  }
}

for (const selectedLetter of [false, true]) {
  test(`downloads the audited browser ZIP with ${selectedLetter ? 'selected letter' : 'resume only'}`, async ({ page }) => {
    const state = await install(page, { selectedLetter })
    await open(page)
    await expectApplicationZip(page, selectedLetter)
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}


test('browser PDF retains Chinese and European characters using same-origin fonts', async ({ page }) => {
  const state = await install(page)
  state.resume.content.summary = '软件工程师 Élodie Müller'
  await open(page)
  await expectApplicationZip(page, false, '软件工程师 Élodie Müller')
  expect(state.fontRequests).toContain('/fonts/NotoSansSC-GB2312-Regular.ttf')
  expect(state.fontRequests).toContain('/fonts/NotoSans-Regular.ttf')
  expect(state.unexpected).toEqual([])
})

test('browser PDF rejects unsupported characters without a download and explains why', async ({ page }) => {
  const state = await install(page)
  state.resume.content.summary = 'Engineer 😀'
  await open(page)
  const downloads: string[] = []
  page.on('download', item => downloads.push(item.suggestedFilename()))
  await page.getByRole('button', { name: /Download application materials|下载申请材料/ }).click()
  await expect(page.getByText(/Some characters cannot be included in the PDF|PDF 暂不支持部分字符/)).toBeVisible()
  await expect(page.getByText(/use a tool that supports those characters|使用支持这些字符的工具导出/)).toBeVisible()
  expect(downloads).toEqual([])
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const change of ['stale', 'missing'] as const) {
  test(`browser export refuses ${change} material after the ready view`, async ({ page }) => {
    const state = await install(page)
    await open(page)
    const download = page.getByRole('button', { name: /Download application materials|下载申请材料/ })
    await expect(download).toBeVisible()
    if (change === 'stale') state.audit.resumeUpdatedAt = '2026-10-29T10:00:00.000Z'
    else state.hideResumeOnExport = true
    const downloads: string[] = []
    page.on('download', item => downloads.push(item.suggestedFilename()))
    const reads = state.requestOwners.length
    await download.click()
    await expect.poll(() => state.requestOwners.length).toBeGreaterThan(reads)
    await expect(page.getByText(/Could not download application materials|无法下载申请材料/)).toBeVisible()
    expect(downloads).toEqual([])
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}


test('complete manual journey keeps one application through discovery, editing, download and recording', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the desktop resume editor and browser download')
  const state = await install(page, { search: true, firstPreparation: true, flowSave: true })
  const manualWrites = () => state.writes.filter(write => write.path.endsWith('/apply'))
  await page.goto(`${origin}/?page=search`)
  await page.getByRole('textbox', { name: /Search jobs|搜索职位/ }).fill('Fixture Engineer')
  await page.getByRole('textbox', { name: /Search jobs|搜索职位/ }).press('Enter')
  await page.getByTitle(/Save to My Jobs|保存到我的职位/).click()
  await page.getByRole('button', { name: /View this application|查看此申请/ }).first().click()
  await expect(page).toHaveURL(/highlight=outside-page/)
  await page.getByRole('button', { name: /Prepare application materials|准备申请材料|Check current materials|检查当前材料/, exact: true }).click()
  await expect.poll(() => state.writes.filter(write => write.path.endsWith('/assign')).length).toBe(1)
  expect(manualWrites()).toEqual([])
  await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  await page.getByRole('button', { name: /Edit this resume|编辑此简历/ }).click()
  await expect(page).toHaveURL(/resumeId=resume-1/)
  await page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first().click()
  await page.locator('[data-resume-editor] textarea').first().fill('Software engineer with TypeScript experience.')
  await expect.poll(() => state.writes.filter(write => write.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page).toHaveURL(/highlight=outside-page/)
  await expect.poll(() => state.writes.filter(write => write.path === '/api/resume/resume-1').length).toBeGreaterThan(0)
  expect(manualWrites()).toEqual([])
  await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
  await expect.poll(() => state.writes.filter(write => write.path.endsWith('/audit-application')).length).toBe(2)
  await expectApplicationZip(page, false)
  expect(manualWrites()).toEqual([])
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: /Open employer website|前往雇主网站/, exact: true }).click()
  await expect((await popupPromise).getByRole('heading', { name: 'Mock employer application' })).toBeVisible()
  expect(manualWrites()).toEqual([])
  await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
  await expect.poll(() => manualWrites().length).toBe(1)
  expect(state.job.status).toBe('applied')
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


test('late resume content waits for explicit analysis and reuses its cache', async ({ page }) => {
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
    await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(state.analysisRequests).toEqual([])
    await page.reload()
    await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(state.analysisRequests).toEqual([])
    const analyze = page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first()
    if (test.info().project.name === 'mobile-zh') { await analyze.focus(); await analyze.press('Enter') }
    else await analyze.click()
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
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
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
    await expect(page.getByText(/Showing cached resume|当前显示缓存的简历/)).toBeVisible()
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
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
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
    await expect.poll(() => state.analysisCalls.filter(call => summaryOf(call.body) === 'Software engineer.').length).toBe(2)
    await page.getByText('Second fixture resume', { exact: true }).click()
    await expect(page.getByText('Second resume content.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
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


test('cached resume requires user to wait for refresh before requesting analysis', async ({ page }) => {
  const state = await install(page, { holdResumeContent: true })
  await page.addInitScript(cached => sessionStorage.setItem('fixture_cached_resume', JSON.stringify(cached)), resume())
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect.poll(() => state.resumeContentRequested).toBe(true)
    await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await expect(page.locator('.resume-opportunity-card')).toContainText('Application flow engineer')
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
    await expect(page.getByText(/Resume is refreshing|正在刷新简历/)).toBeVisible()
    expect(state.analysisRequests).toEqual([])
    const response = page.waitForResponse(response => response.url().endsWith('/api/resume/resume-1') && response.request().method() === 'GET')
    state.releaseResumeContent()
    await response
    await page.waitForLoadState('networkidle')
    expect(state.analysisRequests).toEqual([])
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
    await expect.poll(() => state.analysisRequests.slice().sort()).toEqual(['/api/ai/score', '/api/ai/suggest'])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseResumeContent() }
})

test('same-version older request finishing last cannot replace a later explicit analysis', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume library')
  const state = await install(page, { twoResumes: true, holdFirstAnalysisOnly: true, saveMode: 'hold-success' })
  state.secondResume.targetJobId = 'outside-page'
  const summaryOf = (body: unknown) => (body as { resumeContent?: { summary?: string } })?.resumeContent?.summary
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
    await expect.poll(() => state.analysisCalls.filter(call => summaryOf(call.body) === 'Software engineer.').length).toBe(2)
    await page.getByText('Second fixture resume', { exact: true }).click()
    await page.getByText('Second resume content.', { exact: false }).first().click()
    await page.locator('textarea').first().fill('Edited B content')
    await page.locator('.resume-library-item').filter({ hasText: 'Fixture role resume' }).click()
    await expect.poll(() => state.writes.filter(write => write.path === '/api/resume/resume-2').length).toBeGreaterThan(0)
    state.releaseSave()
    await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')['resume-1:outside-page']?.score?.score)).toBe(82)
    const oldResponses = ['/api/ai/score', '/api/ai/suggest'].map(endpoint => page.waitForResponse(response => response.url().endsWith(endpoint) && summaryOf(response.request().postDataJSON()) === 'Software engineer.'))
    state.releaseOldAnalysis()
    await Promise.all((await Promise.all(oldResponses)).map(response => response.finished()))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')['resume-1:outside-page']?.score?.score)).toBe(82)
    await page.reload()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')['resume-1:outside-page']?.score?.score)).toBe(82)
    expect(state.unexpected).toEqual([])
  } finally { state.releaseOldAnalysis(); state.releaseSave() }
})

test('a late older analysis cannot replace a newer version analysis', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume library')
  const state = await install(page, { twoResumes: true, versionedScore: true, holdOldAnalysis: true })
  state.secondResume.targetJobId = 'outside-page'
  const newTime = '2026-10-30T12:00:00.000Z'
  const summaryOf = (body: unknown) => (body as { resumeContent?: { summary?: string } })?.resumeContent?.summary
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
    await expect.poll(() => state.analysisCalls.filter(call => summaryOf(call.body) === 'Software engineer.').length).toBe(2)
    await page.getByText('Second fixture resume', { exact: true }).click()
    await expect(page.getByText('Second resume content.', { exact: false }).first()).toBeVisible()
    state.resume.updatedAt = newTime
    state.resume.content.summary = 'Updated server resume content.'
    await page.locator('.resume-library-item').filter({ hasText: 'Fixture role resume' }).click()
    await expect(page.getByText('Updated server resume content.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')['resume-1:outside-page'])).toMatchObject({ resumeUpdatedAt: newTime, score: { score: 82 } })
    const oldResponses = ['/api/ai/score', '/api/ai/suggest'].map(endpoint => page.waitForResponse(response => response.url().endsWith(endpoint) && summaryOf(response.request().postDataJSON()) === 'Software engineer.'))
    state.releaseOldAnalysis()
    await Promise.all((await Promise.all(oldResponses)).map(response => response.finished()))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('applymate_last_analysis') ?? '{}')['resume-1:outside-page'])).toMatchObject({ resumeUpdatedAt: newTime, score: { score: 82 } })
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
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
    await expect.poll(() => state.analysisCalls.filter(call => summaryOf(call.body) === 'Software engineer.').length).toBe(2)
    await page.getByText('Second fixture resume', { exact: true }).click()
    await expect(page.getByText('Second resume content.', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
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
      else {
        await page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first().click()
        await expect.poll(() => state.analysisCalls.filter(call => (call.body as { resumeContent?: { summary?: string } }).resumeContent?.summary === 'Software engineer.').length).toBe(2)
      }
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

test('recovery opens the original account resume and application context after another account navigates', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { saveMode: 'hold-success' })
  try {
    await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page&jobsSearch=OwnerFilter&jobsPage=3`)
    await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
    await page.getByRole('dialog').getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
    await page.getByRole('button', { name: /Edit this resume|编辑此简历/ }).click()
    await expect(page).toHaveURL(/page=resume/)
    await page.getByText('Software engineer.', { exact: false }).first().click()
    await page.locator('textarea').first().fill('Owner private draft')
    state.activeUserId = 'fixture-b'
    await fixtureSession(page, 'authenticated', 'fixture-b')
    await page.locator('#desktop-sidebar').getByRole('button', { name: 'Discover', exact: true }).click()
    await expect(page).toHaveURL(/page=search/)
    await page.evaluate(() => history.replaceState(history.state, '', '/?shell=1&page=search&resumeId=other-resume&returnJobId=other-job&jobsSearch=OtherFilter#other'))
    state.activeUserId = 'fixture-user'
    await fixtureSession(page, 'authenticated')
    await expect(page.locator('#recovery-draft')).toHaveValue(/Owner private draft/)
    page.once('dialog', dialog => void dialog.accept())
    await page.getByRole('button', { name: /I have copied it; open resume|我已复制，打开简历/ }).click()
    await expect(page).toHaveURL(/page=resume/)
    await expect(page).toHaveURL(/resumeId=resume-1/)
    await expect(page).toHaveURL(/returnJobId=outside-page/)
    await expect(page).toHaveURL(/jobsSearch=OwnerFilter/)
    const url = new URL(page.url())
    expect(url.href).not.toContain('other-resume')
    expect(url.href).not.toContain('other-job')
    expect(url.href).not.toContain('OtherFilter')
    expect(url.hash).not.toBe('#other')
    expect(state.writes.filter(write => write.path.startsWith('/api/resume/'))).toEqual([])
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


test('application follows original Agent question, review and an unverified outcome', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the real desktop Agent shell')
  const state = await install(page, { taskStatus: 'waiting_for_user', realAgent: true, agentJourney: true })
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  await page.getByRole('link', { name: 'Answer in the original task' }).click()
  await expect(page).toHaveURL(/sessionId=original-session/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  const question = page.locator('[data-agent-question-card="true"]')
  await expect(question).toContainText('Confirm the fixture fact?')
  await question.getByRole('button', { name: 'Yes', exact: true }).click()
  await question.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect.poll(() => state.agentStage).toBe('approval')
  expect(state.agentRequests.find(item => item.method === 'POST')).toMatchObject({ path: '/api/agent/sessions/original-session/questions/fixture-question', body: { expectedTurnId: 'fixture-turn', expectedRevision: 1, answer: 'yes' } })
  // The server state changes are simulated; reload hydrates the same durable session.
  await page.reload()
  await expect(page).toHaveURL(/sessionId=original-session/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  const approval = page.locator('[data-agent-approval-ledger="true"]')
  await expect(approval).toBeVisible()
  await approval.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(() => state.agentStage).toBe('running')
  expect(state.agentRequests.filter(item => item.method === 'POST')[1]).toMatchObject({ path: '/api/agent/sessions/original-session/approvals/fixture-approval', body: { expectedTurnId: 'fixture-turn', expectedRevision: 2, decision: 'approved' } })
  await page.reload()
  await expect(page).toHaveURL(/sessionId=original-session/)
  await expect(page.locator('.agent-context-bar')).toContainText('Fixture application task')
  // Outcome is deliberately unknown; the fixture never performs an external submission.
  state.agentStage = 'unknown'
  await page.reload()
  await expect(page.locator('[data-agent-harness-item="fixture-result"]')).toContainText('Fixture outcome is unverified')
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  await expect(page.getByRole('dialog')).toContainText('Submission outcome unverified')
  await expect(page.getByRole('button', { name: /Record that I submitted/ })).toHaveCount(0)
  expect(state.agentRequests.filter(item => item.method === 'POST')).toHaveLength(2)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})


test('mobile keyboard can reach and activate explicit resume analysis', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-zh', 'Exercises mobile keyboard navigation')
  const state = await install(page)
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  await expect(page.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(state.analysisRequests).toEqual([])
  const analyze = page.getByRole('button', { name: /Analyze match|分析匹配度/ }).first()
  await expect(analyze).toBeEnabled()
  let reached = false
  for (let index = 0; index < 160; index++) {
    await page.keyboard.press('Tab')
    if (await analyze.evaluate(element => document.activeElement === element)) { reached = true; break }
  }
  expect(reached).toBe(true)
  expect(state.analysisRequests).toEqual([])
  await page.keyboard.press('Enter')
  await expect.poll(() => state.analysisRequests.slice().sort()).toEqual(['/api/ai/score', '/api/ai/suggest'])
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})
