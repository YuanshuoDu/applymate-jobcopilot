import { expect, test, type Page, type Route } from '@playwright/test'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { randomInt } from 'node:crypto'
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
      import {useApplicationCoverLetters} from '@/components/jobs/useApplicationCoverLetters';
      import {I18nProvider} from '@/lib/i18n';
      import {ToastProvider} from '@/components/ui';
      import {NavContext} from '@/lib/nav-context';
      import {getCachedApiResponse, setCachedApiResponse} from '@/lib/api-cache';
      const subscribeLocation=(cb)=>{addEventListener('popstate',cb);return()=>removeEventListener('popstate',cb)};
      function AgentDestination(){const sessionId=useSyncExternalStore(subscribeLocation,()=>new URL(location.href).searchParams.get('sessionId'),()=>null);return <div data-testid="agent-destination">{sessionId}</div>}
      function LetterProbe(){
        const [owner,setOwner]=useState('fixture-user');const [job,setJob]=useState('outside-page');
        const value=useApplicationCoverLetters(owner,job,owner,'selected-letter');
        return <div><button onClick={()=>void value.refetch().then(result=>(globalThis.__fixtureLetterOutcomes ||= []).push(result.kind))}>Probe refresh</button><button onClick={()=>setOwner(v=>v==='fixture-user'?'fixture-b':'fixture-user')}>Probe owner</button><button onClick={()=>setJob(v=>v==='outside-page'?'other-job':'outside-page')}>Probe job</button><p data-testid="letter-probe">{value.loading?'loading':value.letter?.content||'unavailable'}</p></div>
      }
      function Harness(){
        const [page,setPage]=useState(new URL(location.href).searchParams.get('page')||'jobs');
        const navigate=(next)=>{const url=new URL(location.href);url.searchParams.set('page',next);history.pushState({},'',url);setPage(next)};
        useEffect(()=>{const restore=()=>setPage(new URL(location.href).searchParams.get('page')||'jobs');addEventListener('popstate',restore);return()=>removeEventListener('popstate',restore)},[]);
        return <I18nProvider><ToastProvider><NavContext.Provider value={{navigate}}>
          <nav aria-label="Fixture navigation">{['jobs','resume','search','dashboard'].map(name=><button key={name} onClick={()=>navigate(name)}>Fixture {name}</button>)}</nav>
          <main style={{display:'flex',height:'calc(100vh - 32px)',minWidth:0}}>
          {page==='jobs'?<JobsPage/>:page==='resume'?<ResumePage/>:page==='search'?<SearchPage/>:page==='dashboard'?<DashboardPage/>:page==='letter-probe'?<LetterProbe/>:<AgentDestination/>}
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
  // Bind directly within a browser-safe range; some Windows ephemeral ranges
  // include Chromium's blocked ports (e.g. 6669).
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(randomInt(20000, 60000), '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port')
      origin = `http://127.0.0.1:${address.port}`
      break
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error
    }
  }
  if (!origin) throw new Error('Fixture server could not obtain a browser-safe port')
})

test.afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
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
  const record = { resumeId: 'resume-1', coverLetterId: null, resumeUpdatedAt,
    audit: { verdict: 'pass', summary: 'Fixture materials checked.', findings: [], matchScore: 82, source: 'independent', auditedAt: time } }
  return record as typeof record & { coverLetterUpdatedAt?: string }
}

async function install(page: Page, options: { stale?: boolean; taskStatus?: 'unknown' | 'waiting_for_user' | 'waiting_for_authorization' | 'cancelled' | 'failed' | 'filling'; recordedInitially?: boolean; evidenceCase?: 'bound' | 'unbound' | 'unavailable'; previewMismatch?: 'owner' | 'id' | 'job'; malformedPreview?: 'content' | 'contact'; letterRaceProbe?: boolean; letterInvalid?: 'null' | 'owner' | 'job' | 'duplicate' | 'content'; letterAfterInitial?: 'changed' | 'failure' | 'hold' | 'manual-change' | 'audit-same' | 'audit-failure' | 'audit-hold'; auditVersion?: 'same' | 'resume-changed' | 'letter-changed' | 'resume-missing' | 'letter-missing'; holdAudit?: boolean; holdAssign?: boolean; externalLetterSelection?: boolean; failTailoredRead?: boolean; taskFailure?: boolean; taskLimited?: boolean; missing?: boolean; holdSelectedLetter?: boolean; selectedLetter?: boolean; firstPreparation?: boolean; descriptionMode?: 'success' | 'unknown' | 'audit' | 'two' | 'conflict' | 'hold-response' | 'hold-other'; initialDescription?: string | null; holdBaseSave?: boolean; failBaseSave?: boolean; baseList?: 'empty' | 'fail-once' | 'fail-once-hold' | 'hold-empty' | 'multiple' | 'single' | 'default'; failFirstAudit?: boolean; flowSave?: boolean; manualOutcome?: 'get-fails' | 'unknown'; search?: boolean; saveMode?: 'fail' | 'hold-success' | 'hold-fail'; twoResumes?: boolean; holdResumeContent?: boolean; snapshotResumeContent?: boolean; resumeRevalidationFails?: boolean; versionedScore?: boolean; holdOldAnalysis?: boolean; holdFirstAnalysisOnly?: boolean; auditCorrection?: boolean; holdAuditCorrection?: boolean; versions?: boolean; holdVersionRestore?: boolean; versionRestoreFails?: boolean; realAgent?: boolean; expiredApproval?: boolean; twoJobQuestions?: boolean; holdFirstTaskRead?: boolean; holdReturnOwnerA?: boolean; taskPerUser?: boolean; dashboardFourTasks?: boolean; agentJourney?: boolean } = {}) {
  let releaseReturnOwnerA = () => {}
  const returnOwnerAGate = new Promise<void>(resolve => { releaseReturnOwnerA = resolve })
  let releaseStaleJob = () => {}
  const staleJobGate = new Promise<void>(resolve => { releaseStaleJob = resolve })
  let releaseFirstTaskRead = () => {}
  const firstTaskReadGate = new Promise<void>(resolve => { releaseFirstTaskRead = resolve })
  if (options.holdFirstTaskRead) await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (typeof input === 'string' && input.startsWith('/api/agent/application-tasks')) return original(input, { ...init, signal: undefined })
      return original(input, init)
    }
  })
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
  let releaseAudit = () => {}
  const auditGate = new Promise<void>(resolve => { releaseAudit = resolve })
  let releaseAssign = () => {}
  const assignGate = new Promise<void>(resolve => { releaseAssign = resolve })
  let releaseProbeLetter = () => {}
  const probeLetterGate = new Promise<void>(resolve => { releaseProbeLetter = resolve })
  if (options.letterRaceProbe || options.letterAfterInitial === 'hold' || options.letterAfterInitial === 'audit-hold') await page.addInitScript(() => { const original = window.fetch.bind(window); window.fetch = (input, init) => typeof input === 'string' && input.endsWith('/cover-letters') ? original(input, { ...init, signal: undefined }) : original(input, init) })
  let releaseOtherJobUpdate = () => {}
  const otherJobUpdateGate = new Promise<void>(resolve => { releaseOtherJobUpdate = resolve })
  let releaseDescription = () => {}
  const descriptionGate = new Promise<void>(resolve => { releaseDescription = resolve })
  let releaseBaseSave = () => {}
  const baseSaveGate = new Promise<void>(resolve => { releaseBaseSave = resolve })
  let releaseBaseList = () => {}
  const baseListGate = new Promise<void>(resolve => { releaseBaseList = resolve })
  let releaseLetters = () => {}
  const lettersGate = new Promise<void>(resolve => { releaseLetters = resolve })
  const state = { job: { ...job(), description: job().description as string | null, followUpAt: null as string | null, appliedAt: null as string | null, finalCoverLetterId: options.holdSelectedLetter || options.selectedLetter ? 'selected-letter' : null, finalResumeId: options.firstPreparation ? null : 'resume-1' }, resume: resume(), audit: options.auditCorrection ? { ...audit(), audit: { ...audit().audit, verdict: 'revise', findings: [{ area: 'resume', target: 'summary', severity: 'warning', title: 'Fix summary', evidence: 'Outdated wording', action: 'Apply correction', proposedValue: 'Audited v2 summary' }] } } : audit(options.stale ? '2026-10-29T10:00:00.000Z' : time),
    secondResume: { ...resume(), id: 'resume-2', name: 'Second fixture resume', targetJobId: null as string | null, content: { ...resume().content, summary: 'Second resume content.' } },
    answeredJobA: false, saveResponses: 0, armReturnOwnerA: false, returnOwnerAEntered: false, releaseReturnOwnerA, manualPosted: false, manualReadAvailable: false, hideResumeOnExport: false, malformedPreview: options.malformedPreview ?? null, selectedLetterAvailable: false, failNextDescriptionAudit: false, descriptionWriteStarted: false, otherJobUpdateStarted: false, releaseDescription, releaseOtherJobUpdate, savedBase: null as (Omit<ReturnType<typeof resume>, 'targetJobId'> & { targetJobId: string | null }) | null, baseSaveStarted: false, releaseBaseSave, baseListReads: 0, releaseBaseList, invalidLetter: options.letterInvalid ?? null, probeLetterReads: 0, selectedLetterReads: 0, changeLetterOnRead: false, auditStarted: false, assignStarted: false, releaseAudit, releaseAssign, releaseProbeLetter, fontRequests: [] as string[], activeUserId: 'fixture-user', agentStage: 'question' as 'question' | 'approval' | 'running' | 'unknown', requestOwners: [] as Array<{ path: string; method: string; userId: string }>, agentRequests: [] as Array<{ path: string; method: string; body?: unknown }>, writes: [] as Array<{ path: string; body: unknown }>, analysisRequests: [] as string[], analysisBodies: [] as unknown[], analysisCalls: [] as Array<{ path: string; body: unknown }>, unexpected: [] as string[], taskReads: 0, staleJobRequested: false, staleJobReturned: false, releaseStaleJob, taskStatusOverride: null as 'waiting_for_authorization' | null, firstTaskReadFinished: false, releaseFirstTaskRead, letterRequested: false, resumeContentRequested: false, releaseLetters, releaseSave, releaseResumeContent, releaseOldAnalysis, releaseAuditCorrection, releaseVersionRestore }
  if (options.descriptionMode) state.job.description = options.initialDescription === undefined ? '' : options.initialDescription
  if (options.evidenceCase === 'unbound') state.job.finalResumeId = null
  if (options.previewMismatch === 'job') state.job.finalResumeId = null
  if (options.evidenceCase === 'unavailable') state.hideResumeOnExport = true
  if (options.failTailoredRead) state.hideResumeOnExport = true
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
      if (pathname === '/api/agent/sessions') return json(route, options.twoJobQuestions ? { sessions: ['session-a', 'session-b'].map(id => ({ id, goal: 'Fixture application task', status: 'waiting_for_user', updatedAt: time })), lastOpenedSessionId: 'session-a' } : { sessions: [{ id: 'original-session', goal: 'Fixture application task', status: 'waiting_for_approval', updatedAt: time }], lastOpenedSessionId: 'original-session' })
      if (options.twoJobQuestions && /^\/api\/agent\/sessions\/session-[ab](?:\/|$)/.test(pathname)) {
        const id = pathname.split('/')[4], prefix = `/api/agent/sessions/${id}`
        const questionId = id === 'session-a' ? 'question-a' : 'question-b'
        const turnId = id === 'session-a' ? 'turn-a' : 'turn-b'
        const answered = id === 'session-a' && state.answeredJobA
        const status = answered ? 'in_progress' : 'waiting_for_user'
        if (pathname === `${prefix}/turns` && method === 'GET') {
          const turn = { id: turnId, sessionId: id, source: 'automation', goal: 'Fixture application task', status, revision: 1, activeStepId: null, finalItemId: null, createdAt: time, updatedAt: time, completedAt: null }
          return json(route, { turns: [turn], projection: { activeTurnId: turnId, activeTurn: { id: turnId, status, revision: 1, goal: turn.goal }, queuedInputCount: 0 } })
        }
        if (pathname === `${prefix}/tasks` && method === 'GET') return json(route, { tasks: [] })
        if (pathname === `${prefix}/timeline` && method === 'GET') {
          const question = { schemaVersion: 'agent-harness.v2', id: `item-${questionId}`, sessionId: id, turnId, stepId: null, taskId: null, type: 'question', status: 'started', phase: 'commentary', revision: 0, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, sequence: '1', content: { waitKind: 'question', questionId, stage: 'profile', question: 'Confirm the same fixture fact?', options: [{ value: 'yes', label: 'Yes' }], answerAvailable: false, pending: true } }
          return json(route, { items: answered ? [] : [question], approvalEvents: [] })
        }
        if (pathname === `${prefix}/events` && method === 'GET') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture waiting\n\n' })
        if (pathname === `${prefix}/questions/question-a` && method === 'POST' && id === 'session-a' && !state.answeredJobA) { state.answeredJobA = true; return json(route, { disposition: 'resolved' }, 202) }
        if (pathname === prefix && (method === 'GET' || method === 'PATCH')) return json(route, { session: { id, goal: 'Fixture application task', status, updatedAt: time, tasks: [], approvals: [], applicationTasks: [], questions: [], artifacts: [], qualityScore: 100 } })
        state.unexpected.push(`${method} ${pathname}`); return json(route, { error: 'Unexpected two-job request' }, 404)
      }
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
      if (pathname === `${prefix}/timeline`) {
        const requested = { schemaVersion: 'agent-harness.v2', id: 'fixture-approval-event', sessionId: 'original-session', turnId: 'fixture-turn', itemId: null, taskId: null, type: 'approval.requested', actor: 'orchestrator', sequence: '1', payload: { approvalId: 'fixture-approval', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 1 } }
        const expired = { ...requested, id: 'fixture-approval-expired', type: 'approval.expired', actor: 'system', sequence: '2' }
        return json(route, { items: [], approvalEvents: options.expiredApproval ? [requested, expired] : [requested] })
      }
      if (pathname === `${prefix}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture waiting\n\n' })
      if (pathname === `${prefix}/approvals/fixture-approval` && method === 'POST') return json(route, { disposition: 'resolved' }, 202)
      if (pathname === prefix && (method === 'GET' || method === 'PATCH')) return json(route, { session: { id: 'original-session', goal: 'Fixture application task', status: 'waiting_for_approval', updatedAt: time, tasks: [], approvals: [], applicationTasks: [], questions: [], artifacts: [], qualityScore: 100 } })
      state.unexpected.push(pathname); return json(route, { error: 'Unexpected agent request' }, 404)
    }
    if (options.realAgent && pathname === '/api/me/agent-task-history-memory' && request.method() === 'GET') return json(route, { enabled: false, version: 0 })
    if (options.realAgent && pathname === '/api/agent') return json(route, { autoApply: false, requireApproval: true, isRunning: false })
    if (pathname === '/api/resume/intake' && request.method() === 'POST') return json(route, { parsed: resume().content })
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
        await json(route, { error: 'Fixture save failed' }, 500)
        state.saveResponses++
        return
      }
      if (pathname === '/api/resume/resume-2' && request.method() === 'PATCH' && options.saveMode === 'hold-success') { await saveGate; return json(route, { ...state.secondResume, ...(body as object) }) }
      if (options.versions && pathname === '/api/resume/resume-1/versions' && request.method() === 'POST') {
        if (options.holdVersionRestore) await versionRestoreGate
        state.resume = { ...state.resume, updatedAt: '2026-10-30T12:00:00.000Z', content: { ...state.resume.content, summary: 'Restored historical summary' } }
        return options.versionRestoreFails ? json(route, { error: 'Fixture uncertain restore' }, 500) : json(route, state.resume)
      }
      if (options.search && pathname === '/api/jobs' && request.method() === 'POST') return json(route, state.job)
      if (options.descriptionMode && pathname === '/api/jobs' && request.method() === 'POST') return json(route, { ...state.job, ...(body as object), id: 'created-job' })
      if (options.descriptionMode && pathname === '/api/jobs/outside-page' && request.method() === 'PATCH') {
        const patch = body as { description?: unknown; expectedEmptyDescription?: unknown; notes?: unknown; followUpAt?: unknown }
        if (typeof patch.description === 'string') {
          state.descriptionWriteStarted = true
          if (options.descriptionMode === 'unknown') return route.abort('failed')
          if (options.descriptionMode === 'conflict') state.job.description = 'Description from another session.'
          if (!Object.hasOwn(patch, 'expectedEmptyDescription') || patch.expectedEmptyDescription !== state.job.description || state.job.description?.trim()) return json(route, { error: 'Description changed' }, 409)
          state.job.description = patch.description
          const saved = { ...state.job }
          if (options.descriptionMode === 'hold-response') await descriptionGate
          return json(route, options.descriptionMode === 'hold-response' ? { id: saved.id, userId: saved.userId, description: saved.description } : saved)
        }
        if (options.descriptionMode === 'hold-response' && typeof patch.notes === 'string') {
          state.job.notes = patch.notes
          return json(route, state.job)
        }
        if (options.descriptionMode === 'hold-other' && (typeof patch.notes === 'string' || typeof patch.followUpAt === 'string')) {
          if (typeof patch.notes === 'string') state.job.notes = patch.notes
          if (typeof patch.followUpAt === 'string') state.job.followUpAt = patch.followUpAt
          const saved = { ...state.job }
          state.otherJobUpdateStarted = true
          await otherJobUpdateGate
          return json(route, saved)
        }
      }
      if (options.auditCorrection && pathname.endsWith('/audit-application/apply')) {
        if (options.holdAuditCorrection) await auditCorrectionGate
        const updatedAt = '2026-10-30T12:00:00.000Z'
        return json(route, { audit: { ...state.audit.audit, findings: [] }, target: 'summary', appliedContent: 'Audited v2 summary', resume: { ...state.resume, updatedAt, content: { ...state.resume.content, summary: 'Audited v2 summary' } }, coverLetter: null, resumeUpdatedAt: updatedAt })
      }
      if (pathname.endsWith('/tailor-resume')) return json(route, { adaptedResumeId: 'resume-1' })
      if (pathname === '/api/resume' && options.baseList === 'empty') { state.baseSaveStarted = true; if (options.holdBaseSave) await baseSaveGate; if (options.failBaseSave) return route.abort('failed'); const saved = body as { name: string; content: ReturnType<typeof resume>['content'] }; state.savedBase = { ...state.resume, id: 'base-created', kind: 'base', targetJobId: null, name: saved.name, content: saved.content }; return json(route, state.savedBase) }
      if (pathname.endsWith('/audit-application')) { state.auditStarted = true; if (options.holdAudit) await auditGate; if (options.failFirstAudit && state.writes.filter(write => write.path.endsWith('/audit-application')).length === 1) return json(route, { error: 'Fixture audit unavailable' }, 500); const letterId = (body as { coverLetterId: string | null }).coverLetterId; state.audit = { ...audit(state.resume.updatedAt), coverLetterId: letterId, ...(letterId ? { coverLetterUpdatedAt: time } : {}) }; return json(route, { ...state.audit.audit, ...(options.auditVersion === 'resume-missing' ? {} : { resumeUpdatedAt: options.auditVersion === 'resume-changed' ? '2026-10-30T11:00:00.000Z' : state.resume.updatedAt }), ...(letterId && options.auditVersion !== 'letter-missing' ? { coverLetterUpdatedAt: options.auditVersion === 'letter-changed' ? '2026-10-30T11:00:00.000Z' : time } : {}) }) }
      if (pathname.endsWith('/assign')) { state.assignStarted = true; if (options.holdAssign) await assignGate; Object.assign(state.job, body); return json(route, state.job) }
      if (pathname === '/api/jobs/outside-page/apply') { state.manualPosted = true; if (options.manualOutcome === 'unknown') return route.abort('failed'); Object.assign(state.job, { status: 'applied', workflowState: 'submitted', appliedAt: time }); return json(route, { applied: true }) }
      return json(route, { error: 'Unexpected mutation' }, 500)
    }
    if (options.search && pathname === '/api/search/unified') return json(route, { jobs: [{ id: 'search-result-1', title: state.job.role, company: state.job.company, location: state.job.location, url: state.job.url, description: '', source: 'manual', score: 82 }], meta: null })
    if (pathname === '/api/agent/application-tasks') {
      state.taskReads++
      if (options.taskFailure) return json(route, { error: 'Fixture unavailable' }, 500)
      if (options.taskLimited) return json(route, { tasks: Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, userId: 'fixture-user', jobId: `other-job-${i}`, sessionId: `session-${i}`, status: 'filling', checkpoint: null, updatedAt: time, job: { company: 'Other employer', role: 'Other role' } })) })
      if (options.twoJobQuestions) return json(route, { tasks: [{ id: 'task-a', userId: 'fixture-user', jobId: 'outside-page', sessionId: 'session-a', status: state.answeredJobA ? 'filling' : 'waiting_for_user', checkpoint: state.answeredJobA ? null : 'form_answer_required', updatedAt: time, job: { company: 'Fixture Employer', role: 'Application flow engineer' } }, { id: 'task-b', userId: 'fixture-user', jobId: 'job-2', sessionId: 'session-b', status: 'waiting_for_user', checkpoint: 'form_answer_required', updatedAt: time, job: { company: 'Employer B', role: 'Role B' } }] })
      if (options.dashboardFourTasks) return json(route, { tasks: [1, 2, 3, 4].map(n => ({ id: `task-${n}`, userId: 'fixture-user', jobId: `job-${n}`, sessionId: `session-${n}`, status: 'waiting_for_user', checkpoint: 'form_answer_required', updatedAt: `2026-10-30T1${4 - n}:00:00.000Z`, job: { company: `Employer ${n}`, role: `Role ${n}` } })) })
      if (options.taskPerUser && state.activeUserId === 'fixture-b') return json(route, { tasks: [{ id: 'task-b', userId: 'fixture-b', jobId: 'job-b', sessionId: 'session-b', status: 'waiting_for_authorization', checkpoint: 'form_filled', updatedAt: time, job: { company: 'Fixture B', role: 'Engineer B' } }] })
      if (options.holdReturnOwnerA && state.activeUserId === 'fixture-user' && state.armReturnOwnerA) { state.returnOwnerAEntered = true; await returnOwnerAGate }
      const currentTaskStatus = options.agentJourney ? ({ question: 'waiting_for_user', approval: 'waiting_for_authorization', running: 'filling', unknown: 'unknown' } as const)[state.agentStage] : state.taskStatusOverride ?? options.taskStatus
      if (options.holdFirstTaskRead && state.taskReads === 1) {
        await firstTaskReadGate
        await json(route, { tasks: [{ id: 'task-1', userId: 'fixture-user', jobId: state.job.id, sessionId: 'original-session', status: currentTaskStatus, checkpoint: 'form_answer_required', updatedAt: time, job: { company: state.job.company, role: state.job.role } }] })
        state.firstTaskReadFinished = true
        return
      }
      return json(route, { tasks: currentTaskStatus ? [{ id: 'task-1', userId: 'fixture-user', jobId: state.job.id, sessionId: 'original-session', status: currentTaskStatus,
        checkpoint: currentTaskStatus === 'unknown' ? 'submission_uncertain' : currentTaskStatus === 'waiting_for_user' ? 'form_answer_required' : currentTaskStatus === 'cancelled' || currentTaskStatus === 'failed' ? 'turn_stopped_before_submit' : null, updatedAt: time, job: { company: state.job.company, role: state.job.role } }] : [] })
    }
    if (pathname === '/api/dashboard') return json(route, { stats: { total: 0, saved: 0, applied: 0, inProgress: 0, interviews: 0, offers: 0, rejected: 0, thisWeek: 0 }, savedJobs: options.dashboardFourTasks ? [{ id: 'job-4', company: 'Employer 4', role: 'Role 4', score: 60, createdAt: time, url: null }] : [], followUpsDue: options.dashboardFourTasks ? [{ id: 'job-4', company: 'Employer 4', role: 'Role 4', status: 'applied', followUpAt: time }] : [], activity: [], applicationDays: [], interviewsScheduled: [], todayRecommendations: [], agentConfig: null, hasResume: true })
    if (pathname === '/api/jobs') return json(route, { jobs: options.descriptionMode === 'two' ? [state.job, { ...state.job, id: 'job-2', role: 'Second fixture role', company: 'Second Employer' }] : url.searchParams.has('finalResumeId') || url.searchParams.get('pageSize') === '30' ? [state.job] : [], total: 80, statusCounts: { saved: 80, applied: 0, interview: 0, offer: 0, rejected: 0 } })
    if ((options.twoJobQuestions || options.descriptionMode === 'two') && pathname === '/api/jobs/job-2') return json(route, { ...state.job, id: 'job-2', company: 'Employer B', role: 'Role B' })
    if (options.dashboardFourTasks && pathname === '/api/jobs/stale-job') { state.staleJobRequested = true; await staleJobGate; await json(route, { ...state.job, id: 'stale-job', company: 'Stale Employer', role: 'Stale Role' }); state.staleJobReturned = true; return }
    if (pathname === `/api/jobs/${state.job.id}` && state.manualPosted && options.manualOutcome === 'get-fails' && !state.manualReadAvailable) return json(route, { error: 'Fixture read unavailable' }, 500)
    if (pathname === `/api/jobs/${state.job.id}` && state.manualPosted && options.manualOutcome === 'get-fails' && state.manualReadAvailable) return json(route, { ...state.job, status: 'saved', workflowState: 'draft', appliedAt: null })
    if (pathname === `/api/jobs/${state.job.id}`) return options.missing ? json(route, { error: 'Not found' }, 404) : json(route, state.job)
    if (pathname.endsWith('/cover-letters')) {
      if (options.letterRaceProbe) { const read = ++state.probeLetterReads; const item = { id: 'selected-letter', userId: state.activeUserId, jobId: pathname.split('/')[3], content: read <= 2 ? `Old fixture letter ${read}` : `Current fixture letter ${read}`, updatedAt: time }; if (read <= 2) await probeLetterGate; return json(route, [item]) }
      if (state.invalidLetter) { const item = { id: 'selected-letter', userId: state.invalidLetter === 'owner' ? 'other-user' : 'fixture-user', jobId: state.invalidLetter === 'job' ? 'other-job' : 'outside-page', content: state.invalidLetter === 'content' ? null : 'Fixture selected cover letter.', updatedAt: time }; return json(route, state.invalidLetter === 'null' ? [null] : state.invalidLetter === 'duplicate' ? [item, item] : [item]) }
      if (options.letterAfterInitial) { const read = ++state.selectedLetterReads; if (read > 1 && options.letterAfterInitial === 'failure' || read > 2 && options.letterAfterInitial === 'audit-failure') return json(route, { error: 'Fixture refresh failed' }, 500); if (read > 1 && options.letterAfterInitial === 'hold' || read > 2 && options.letterAfterInitial === 'audit-hold') await probeLetterGate; const changed = read > 1 && (options.letterAfterInitial === 'changed' || (options.letterAfterInitial === 'manual-change' && state.changeLetterOnRead)); return json(route, [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: changed ? 'Changed cover letter.' : 'Original cover letter.', tone: 'professional', createdAt: time, updatedAt: changed ? '2026-10-30T11:00:00.000Z' : time }]) }
      if (options.holdSelectedLetter) { state.letterRequested = true; await lettersGate; return state.selectedLetterAvailable ? json(route, [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Fixture selected cover letter.', tone: 'professional', createdAt: time, updatedAt: time }]) : json(route, { error: 'Fixture letter unavailable' }, 500) }
      return json(route, options.selectedLetter || options.externalLetterSelection && state.job.finalCoverLetterId ? [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'I am excited to contribute my TypeScript experience.', tone: 'professional', createdAt: time, updatedAt: time }] : [])
    }
    if (pathname.endsWith('/audit-application') && state.failNextDescriptionAudit) { state.failNextDescriptionAudit = false; return json(route, { error: 'Fixture audit check unavailable' }, 500) }
    if (pathname.endsWith('/audit-application') && options.evidenceCase) return json(route, { ...audit(), audit: { ...audit().audit, verdict: 'needs_review', findings: [{ area: 'resume', severity: 'warning', resolution: 'evidence_needed', target: 'summary', title: 'Fixture evidence', evidence: 'No independent support', action: 'Review the claim' }] } })
    if (pathname.endsWith('/audit-application')) return json(route, options.descriptionMode === 'audit' ? state.audit : options.firstPreparation && !state.writes.some(write => write.path.endsWith('/audit-application')) ? null : state.audit)
    if (pathname === '/api/resume' && options.baseList) {
      const read = ++state.baseListReads
      if (options.baseList === 'hold-empty' || options.baseList === 'fail-once-hold' && read > 1) await baseListGate
      if ((options.baseList === 'fail-once' || options.baseList === 'fail-once-hold') && read === 1) return json(route, { error: 'Fixture list unavailable' }, 500)
      if (options.baseList === 'empty' && state.savedBase) return json(route, [state.savedBase])
      if (options.baseList === 'empty' || options.baseList === 'hold-empty' || options.baseList === 'fail-once' || options.baseList === 'fail-once-hold') return json(route, [])
      const first = { ...state.resume, id: 'base-1', name: 'First base', kind: 'base', targetJobId: null, isDefault: options.baseList === 'default' }
      return json(route, options.baseList === 'single' ? [first] : [first, { ...first, id: 'base-2', name: 'Second base', isDefault: false }])
    }
    if (pathname === '/api/resume' && options.firstPreparation) return json(route, [{ ...state.resume, id: 'base-1', kind: 'base', targetJobId: null, isDefault: true }])
    if (pathname === '/api/resume') return json(route, state.activeUserId === 'fixture-b' ? [{ ...state.resume, id: 'resume-b', userId: 'fixture-b', name: 'Account B resume', targetJobId: null, content: { ...state.resume.content, summary: 'Account B only' } }] : options.twoResumes ? [state.resume, state.secondResume] : [state.resume])
    if (pathname === '/api/resume/base-created' && state.savedBase) return json(route, state.savedBase)
    if (pathname === '/api/resume/resume-b') return json(route, { ...state.resume, id: 'resume-b', userId: 'fixture-b', name: 'Account B resume', targetJobId: null, content: { ...state.resume.content, summary: 'Account B only' } })
    if (pathname === '/api/resume/resume-1' && state.activeUserId === 'fixture-b') return json(route, { error: 'Not found' }, 404)
    if (pathname === '/api/resume/resume-2') return json(route, state.secondResume)
    if (pathname === '/api/resume/resume-1' && options.holdResumeContent) { const snapshot = structuredClone(state.resume); state.resumeContentRequested = true; await resumeContentGate; return options.resumeRevalidationFails ? json(route, { error: 'Fixture revalidation failed' }, 500) : json(route, options.snapshotResumeContent ? snapshot : state.resume) }
    if (pathname === '/api/resume/resume-1' && state.hideResumeOnExport) return json(route, { error: 'Fixture material unavailable' }, options.failTailoredRead ? 500 : 404)
    if (pathname === '/api/resume/resume-1' && state.malformedPreview === 'content') { const { content: _content, ...incomplete } = state.resume; return json(route, incomplete) }
    if (pathname === '/api/resume/resume-1' && state.malformedPreview === 'contact') { const { contact: _contact, ...incomplete } = state.resume.content; return json(route, { ...state.resume, content: incomplete }) }
    if (pathname === '/api/resume/resume-1' && options.previewMismatch) return json(route, { ...state.resume, ...(options.previewMismatch === 'owner' ? { userId: 'other-user' } : options.previewMismatch === 'id' ? { id: 'other-resume' } : { targetJobId: 'other-job' }) })
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

test('a failed jobs refresh shows an error and retry restores the list', async ({ page }) => {
  const state = await install(page, { descriptionMode: 'two' })
  let failNextList = false
  await page.route('**/api/jobs?*', async route => {
    if (route.request().method() === 'GET' && failNextList) {
      failNextList = false
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture list unavailable' }) })
    }
    return route.fallback()
  })
  await page.goto(`${origin}/?page=jobs`)
  await expect(page.getByText('Second fixture role', { exact: true }).first()).toBeVisible()
  failNextList = true
  const failed = page.waitForResponse(response => response.url().includes('/api/jobs?') && response.status() === 500)
  await page.evaluate(() => window.postMessage({ type: 'nav-refresh' }, '*'))
  await failed
  await expect(page.getByText(/Couldn’t load your jobs|无法加载职位/)).toBeVisible()
  await expect(page.getByText(/^(No jobs found|暂无职位)$/)).toHaveCount(0)
  await page.getByRole('button', { name: /^(Retry|重试)$/ }).click()
  await expect(page.getByText('Second fixture role', { exact: true }).first()).toBeVisible()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('opens the exact application from a keyboard-accessible Kanban card and retains the board', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Kanban desktop interaction')
  const state = await install(page, { descriptionMode: 'two' })
  await page.goto(`${origin}/?page=jobs&jobsView=kanban`)
  const card = page.locator('[data-col="saved"] [draggable="true"]').filter({ hasText: 'Second fixture role' })
  await expect(card).toBeVisible()
  const openApplication = card.getByRole('button', { name: /View this application|查看此申请/ })
  await expect(openApplication).toBeVisible()
  await expect(openApplication).toHaveAccessibleName(/Second Employer.*Second fixture role/)
  expect(await openApplication.evaluate(element => (element as HTMLButtonElement).tabIndex)).toBeGreaterThanOrEqual(0)
  await openApplication.focus()
  await page.keyboard.press('Enter')
  const drawer = page.getByRole('dialog')
  await expect(drawer).toContainText('Second fixture role')
  await expect(drawer).toContainText('Second Employer')
  await expect(page).toHaveURL(/highlight=job-2/)
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(page).toHaveURL(/jobsView=kanban/)
  await expect(card).toBeVisible()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('Kanban cards retain drag-to-status after adding the application entry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Kanban desktop interaction')
  const state = await install(page, { descriptionMode: 'two' })
  const changes: unknown[] = []
  await page.route('**/api/jobs/job-2', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    changes.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'job-2', status: 'interview' }) })
  })
  await page.goto(`${origin}/?page=jobs&jobsView=kanban`)
  const card = page.locator('[data-col="saved"] [draggable="true"]').filter({ hasText: 'Second fixture role' })
  await expect(card.getByRole('button', { name: /View this application|查看此申请/ })).toBeVisible()
  const destination = page.locator('[data-col="interview"]')
  await card.dragTo(destination)
  await expect.poll(() => changes).toEqual([{ status: 'interview' }])
  await expect(destination.locator('[draggable="true"]').filter({ hasText: 'Second fixture role' })).toBeVisible()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
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


for (const change of ['account', 'leave'] as const) {
  test(`late Resume material confirmation after ${change} does not update the new context`, async ({ page }) => {
    const state = await install(page, { holdAssign: true })
    state.job.finalResumeId = null
    try {
      await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
      await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
      await dialog.getByRole('button', { name: /Confirm application package|确认申请包/, exact: true }).click()
      await expect.poll(() => state.assignStarted).toBe(true)
      if (change === 'account') {
        state.activeUserId = 'fixture-b'
        await page.evaluate(() => (globalThis as typeof globalThis & { __fixtureSetSession: (status: string, id: string) => void }).__fixtureSetSession('authenticated', 'fixture-b'))
      } else {
        await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
        await page.getByRole('button', { name: 'Fixture jobs' }).click()
        await expect(page).toHaveURL(/page=jobs/)
      }
      const late = page.waitForResponse(response => response.url().endsWith('/assign') && response.status() === 200)
      state.releaseAssign()
      await (await late).finished()
      await expect(page.getByText(/Application pack confirmed|申请包已确认/)).toHaveCount(0)
      if (change === 'leave') await expect(page).toHaveURL(/page=jobs/)
      expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(1)
      expect(state.unexpected).toEqual([])
    } finally { state.releaseAssign() }
  })
}

for (const mismatch of ['owner', 'job'] as const) {
  test(`Resume confirmation rejects an assignment response for the wrong ${mismatch}`, async ({ page }) => {
    const state = await install(page)
    state.job.finalResumeId = null
    await page.route('**/api/jobs/outside-page/assign', async route => {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...state.job, finalResumeId: 'resume-1', ...(mismatch === 'owner' ? { userId: 'fixture-b' } : { id: 'job-2' }) }) })
    })
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
    await dialog.getByRole('button', { name: /Confirm application package|确认申请包/, exact: true }).click()
    await expect(page.getByText(/Could not confirm application pack|无法确认申请包/)).toBeVisible()
    await expect(dialog.getByText(/Application pack confirmed|申请包已确认/)).toHaveCount(0)
    await expect(page).toHaveURL(/page=resume/)
    expect(state.unexpected).toEqual([])
  })
}

for (const auditTiming of ['loaded', 'late'] as const) {
  test(`Resume audit stays with its job when its ${auditTiming} result is followed by a relink`, async ({ page }) => {
    const state = await install(page, { descriptionMode: 'two' })
    state.job.finalResumeId = null
    if (auditTiming === 'late') await page.addInitScript(() => {
      const original = window.fetch.bind(window)
      window.fetch = (input, init) => typeof input === 'string' && input.endsWith('/audit-application') && (!init?.method || init.method === 'GET') ? original(input, { ...init, signal: undefined }) : original(input, init)
    })
    let releaseAudit = () => {}
    const gate = new Promise<void>(resolve => { releaseAudit = resolve })
    let auditAReads = 0
    let auditBReads = 0
    const writes: unknown[] = []
    await page.route('**/api/jobs?*', route => route.fulfill({ json: { jobs: [state.job, { ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role' }], total: 2 } }))
    await page.route('**/api/jobs/*/audit-application', async route => {
      const id = new URL(route.request().url()).pathname.split('/')[3]
      if (id === 'outside-page') {
        auditAReads++
        if (auditTiming === 'late') await gate
        return route.fulfill({ json: { ...audit(), audit: { ...audit().audit, summary: 'Audit belongs to first job only' } } })
      }
      auditBReads++
      return route.fulfill({ json: null })
    })
    await page.route('**/api/resume/resume-1', async route => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      const body = route.request().postDataJSON() as { unlinkJob?: boolean; targetJobId?: string }
      writes.push(body)
      return route.fulfill({ json: { ...state.resume, targetJobId: body.unlinkJob ? null : body.targetJobId } })
    })
    try {
      await page.goto(`${origin}/?page=resume&resumeId=resume-1`)
      await expect.poll(() => auditAReads).toBeGreaterThan(0)
      if (auditTiming === 'loaded') {
        await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
        await expect(page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })).toContainText('Audit belongs to first job only')
        await page.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
      }
      await page.getByRole('button', { name: 'More actions for Fixture role resume' }).click()
      await page.getByRole('menu').getByRole('button', { name: /Cancel link|取消关联/ }).click()
      await expect(page.getByText('Cancel job link?')).toBeVisible()
      await page.getByRole('button', { name: 'Cancel link', exact: true }).click()
      const chooseJob = page.locator('.resume-opportunity-card select')
      await chooseJob.selectOption('job-2')
      await page.locator('.resume-opportunity-card').getByRole('button', { name: /Link resume|关联简历/ }).click()
      await expect(page.locator('.resume-opportunity-card')).toContainText('Second fixture role')
      await expect.poll(() => auditBReads).toBeGreaterThan(0)
      if (auditTiming === 'late') {
        const late = page.waitForResponse(response => response.url().includes('/outside-page/audit-application') && response.status() === 200)
        releaseAudit()
        await (await late).finished()
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      }
      await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
      await expect(dialog).toContainText('Second fixture role')
      await expect(dialog).not.toContainText('Audit belongs to first job only')
      await expect(dialog.getByRole('button', { name: /Confirm application package|确认申请包/, exact: true })).toBeDisabled()
      await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
      await page.getByRole('button', { name: 'More actions for Fixture role resume' }).click()
      await page.getByRole('menu').getByRole('button', { name: /Cancel link|取消关联/ }).click()
      await page.getByRole('button', { name: 'Cancel link', exact: true }).click()
      await chooseJob.selectOption('outside-page')
      await page.locator('.resume-opportunity-card').getByRole('button', { name: /Link resume|关联简历/ }).click()
      await expect(page.locator('.resume-opportunity-card')).toContainText('Application flow engineer')
      await expect.poll(() => auditAReads).toBeGreaterThan(1)
      await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
      await expect(page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })).toContainText('Audit belongs to first job only')
      expect(writes).toHaveLength(4)
      expect(state.unexpected).toEqual([])
    } finally { releaseAudit() }
  })
}

test('failed fresh resume read hides the previous content until retry succeeds', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Exercises desktop resume library')
  const state = await install(page, { twoResumes: true })
  let reads = 0
  await page.route('**/api/resume/resume-2', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    reads++
    return reads === 1 ? route.fulfill({ status: 500, json: { error: 'Fixture unavailable' } }) : route.fulfill({ json: state.secondResume })
  })
  await page.goto(`${origin}/?page=resume&resumeId=resume-1`)
  await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
  await page.locator('.resume-library-item').filter({ hasText: 'Second fixture resume' }).click()
  const error = page.getByRole('alert').filter({ hasText: /Could not load the selected resume|无法加载所选简历/ })
  await expect(error).toBeVisible()
  await expect(page.locator('[data-resume-editor]')).toHaveCount(0)
  expect(state.writes).toEqual([])
  await error.getByRole('button', { name: /Retry|重试/ }).click()
  await expect(page.locator('[data-resume-editor]').getByText('Second resume content.', { exact: false }).first()).toBeVisible()
  expect(reads).toBe(2)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('edited resume is saved before an audit of its current version', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Exercises desktop resume editor')
  const state = await install(page, { flowSave: true })
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  const editor = page.locator('[data-resume-editor]')
  await editor.getByText('Software engineer.', { exact: false }).first().click()
  await editor.locator('textarea').first().fill('Edited verified summary')
  await page.getByRole('button', { name: /Run independent audit|Run audit again|运行独立审核|再次运行审核/ }).click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual(['/api/resume/resume-1', '/api/jobs/outside-page/audit-application'])
  const saved = state.writes[0].body as { content?: { summary?: string } }
  expect(saved.content?.summary).toBe('Edited verified summary')
  expect(state.writes[1].body).toEqual({ resumeId: 'resume-1' })
  await expect(page.getByText(/Fixture materials checked/).first()).toBeVisible()
  expect(state.unexpected).toEqual([])
})

test('reopening confirmed materials reuses the current binding and audit without a write', async ({ page }) => {
  const state = await install(page)
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  await expect(page.locator('[data-resume-editor]').getByText('Software engineer.', { exact: false }).first()).toBeVisible()
  await expect(page.locator('.resume-opportunity-card')).toContainText('Application flow engineer')
  const openConfirmation = page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })
  const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
  for (let attempt = 0; attempt < 2; attempt++) {
    await openConfirmation.click()
    await expect(dialog).toContainText(/Application pack confirmed|申请包已确认/)
    await expect(dialog.getByRole('button', { name: /Confirm application package|确认申请包/, exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /View this application|查看此申请/, exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
  }
  expect(state.writes).toEqual([])
  expect(state.analysisRequests).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('unconfirmed material assignment blocks another assignment and application navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Exercises desktop resume controls')
  const state = await install(page)
  state.job.finalResumeId = null
  let attempts = 0
  await page.route('**/api/jobs/outside-page/assign', async route => { attempts++; await route.abort('failed') })
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
  await page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ }).getByRole('button', { name: /Confirm application package|确认申请包/, exact: true }).click()
  await expect(page.getByText(/Material confirmation is unconfirmed|材料确认结果待核实/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeDisabled()
  await expect(page).toHaveURL(/page=resume/)
  expect(attempts).toBe(1)
  expect(state.unexpected).toEqual([])
})

test('unconfirmed audit correction retains later edits without saving over the uncertain result', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop audit controls')
  const state = await install(page, { auditCorrection: true })
  let attempts = 0
  await page.route('**/api/jobs/outside-page/audit-application/apply', async route => { attempts++; await route.abort('failed') })
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  const editor = page.locator('[data-resume-editor]')
  await editor.getByText('Software engineer.', { exact: false }).first().click()
  await page.getByRole('button', { name: 'Apply generated fix', exact: true }).click()
  await expect(page.getByText(/The correction result is unconfirmed|材料修正结果待核实/)).toBeVisible()
  await editor.getByText('Software engineer.', { exact: false }).first().click()
  await editor.locator('textarea').first().fill('Local edit after uncertain correction')
  await page.waitForTimeout(2300)
  await expect(editor.locator('textarea').first()).toHaveValue('Local edit after uncertain correction')
  expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
  expect(attempts).toBe(1)
  expect(state.unexpected).toEqual([])
})

test('pending and unconfirmed job link blocks another link, review and return', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Exercises desktop resume controls')
  const state = await install(page, { descriptionMode: 'two' })
  state.job.finalResumeId = null
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const requests: unknown[] = []
  await page.route('**/api/resume', route => route.fulfill({ json: [{ ...state.resume, targetJobId: null }] }))
  await page.route('**/api/resume/resume-1', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ...state.resume, targetJobId: null } })
    requests.push(route.request().postDataJSON())
    await gate
    return route.abort('failed')
  })
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    const card = page.locator('.resume-opportunity-card')
    const select = card.locator('select')
    await select.selectOption('outside-page')
    const link = card.getByRole('button', { name: /Link resume|关联简历/ })
    await link.click()
    await expect.poll(() => requests).toEqual([{ targetJobId: 'outside-page' }])
    await expect(page.getByText(/Saving the job link|正在保存职位关联/)).toBeVisible()
    await select.selectOption('job-2')
    await expect(link).toBeDisabled()
    await expect(page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeDisabled()
    release()
    await expect(page.getByText(/The job link is unconfirmed|职位关联结果待核实/)).toBeVisible()
    await expect(link).toBeDisabled()
    await expect(page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeDisabled()
    expect(requests).toEqual([{ targetJobId: 'outside-page' }])
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('late audit correction after unlink keeps local edits without automatic save', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop audit controls')
  const state = await install(page, { auditCorrection: true, holdAuditCorrection: true })
  state.job.finalResumeId = null
  let unlinkWrites = 0
  await page.route('**/api/resume/resume-1', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    const body = route.request().postDataJSON() as { unlinkJob?: boolean }
    if (!body.unlinkJob) return route.fallback()
    unlinkWrites++
    return route.fulfill({ json: { ...state.resume, targetJobId: null } })
  })
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1`)
    await page.getByRole('button', { name: 'Apply generated fix', exact: true }).click()
    await expect.poll(() => state.writes.some(write => write.path.endsWith('/audit-application/apply'))).toBe(true)
    const editor = page.locator('[data-resume-editor]')
    await editor.getByText('Software engineer.', { exact: false }).first().click()
    await editor.locator('textarea').first().fill('Local edit during first job correction')
    await page.getByRole('button', { name: 'More actions for Fixture role resume' }).click()
    await page.getByRole('menu').getByRole('button', { name: /Cancel link|取消关联/ }).click()
    await page.getByRole('button', { name: 'Cancel link', exact: true }).click()
    await expect(page.locator('.resume-opportunity-card select')).toBeVisible()
    expect(unlinkWrites).toBe(1)
    const late = page.waitForResponse(response => response.url().endsWith('/audit-application/apply') && response.status() === 200)
    state.releaseAuditCorrection()
    await (await late).finished()
    await expect(page.getByText(/Copy them, then reload and review|请先复制/).first()).toBeVisible()
    await expect(editor.getByText('Local edit during first job correction', { exact: false }).first()).toBeVisible()
    await page.waitForTimeout(2300)
    expect(state.writes.filter(write => write.path === '/api/resume/resume-1')).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseAuditCorrection() }
})

for (const responseKind of ['empty', 'wrong-resume', 'wrong-owner', 'missing-date', 'invalid-date', 'network'] as const) {
  test(`resume save ${responseKind} result preserves the draft without retry or navigation`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume save controls')
    const state = await install(page)
    let attempts = 0
    await page.route('**/api/resume/resume-1', async route => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      attempts++
      if (responseKind === 'network') return route.abort('failed')
      const data = responseKind === 'empty' ? {} : { ...state.resume,
        ...(responseKind === 'wrong-resume' ? { id: 'resume-2' } : {}),
        ...(responseKind === 'wrong-owner' ? { userId: 'fixture-b' } : {}),
        ...(responseKind === 'missing-date' ? { updatedAt: undefined } : {}),
        ...(responseKind === 'invalid-date' ? { updatedAt: 'invalid' } : {}) }
      return route.fulfill({ status: 200, json: data })
    })
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    const editor = page.locator('[data-resume-editor]')
    await editor.getByText('Software engineer.', { exact: false }).first().click()
    await editor.locator('textarea').first().fill('Draft remains after uncertain save')
    await expect(page.locator('.resume-top-save')).toContainText(/Saving soon|即将保存/)
    await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
    await expect.poll(() => attempts).toBe(1)
    await expect(page.getByText(/The resume save is unconfirmed|简历保存结果待核实/)).toBeVisible()
    await expect(editor.getByText('Draft remains after uncertain save', { exact: false }).first()).toBeVisible()
    await expect(page).toHaveURL(/page=resume/)
    await page.waitForTimeout(2300)
    expect(attempts).toBe(1)
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('resume save waits for subsequent edits and confirms both valid responses', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop resume save controls')
  const state = await install(page)
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const saves: Array<{ content: { summary: string } }> = []
  await page.route('**/api/resume/resume-1', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    const body = route.request().postDataJSON() as { content: { summary: string } }
    saves.push(body)
    const first = saves.length === 1
    if (first) await gate
    return route.fulfill({ json: { ...state.resume, ...body, updatedAt: first ? '2026-10-30T11:00:00.000Z' : '2026-10-30T12:00:00.000Z' } })
  })
  try {
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    const editor = page.locator('[data-resume-editor]')
    await editor.getByText('Software engineer.', { exact: false }).first().click()
    const input = editor.locator('textarea').first()
    await input.fill('First edit')
    await expect.poll(() => saves.length).toBe(1)
    await input.fill('Later edit')
    release()
    await expect.poll(() => saves.length).toBe(2)
    expect(saves.map(save => save.content.summary)).toEqual(['First edit', 'Later edit'])
    await expect(page.getByText(/The resume save is unconfirmed|简历保存结果待核实/)).toHaveCount(0)
    await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
    await expect(page).toHaveURL(/page=jobs/)
    await expect(page).toHaveURL(/highlight=outside-page/)
    expect(state.unexpected).toEqual([])
  } finally { release() }
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

test('unlinked application explains that the Agent workspace may reopen an older session', async ({ page }) => {
  const state = await install(page)
  await open(page, '&sessionId=old-session')
  const drawer = page.getByRole('dialog')
  await expect(drawer).toContainText(/No Agent task is linked to this job|此职位没有关联的 Agent 任务/)
  await expect(drawer).toContainText(/may reopen a recent conversation|工作区可能打开最近的对话/)
  await expect(drawer).toContainText(/does not create a task or authorize submission|不会创建任务或授权提交/)
  await drawer.getByRole('button', { name: /Open Agent workspace|打开 Agent 工作区/ }).click()
  await expect(page).toHaveURL(/page=agent/)
  await expect(page.getByTestId('agent-destination')).toHaveText('old-session')
  expect(state.writes).toEqual([])
  expect(state.agentRequests.filter(item => item.method === 'POST')).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('unavailable task status explains uncertainty and offers a read-only refresh', async ({ page }) => {
  const state = await install(page, { taskFailure: true })
  await open(page, '&sessionId=old-session')
  const drawer = page.getByRole('dialog')
  await expect(drawer).toContainText(/The Agent task status cannot be confirmed|无法确认此职位的 Agent 任务状态/)
  await expect(drawer).not.toContainText(/No Agent task is linked to this job|此职位没有关联的 Agent 任务/)
  const readsBefore = state.taskReads
  await drawer.getByRole('button', { name: /Refresh status|刷新状态/ }).click()
  await expect.poll(() => state.taskReads).toBeGreaterThan(readsBefore)
  await expect(drawer).toContainText(/The Agent task status cannot be confirmed|无法确认此职位的 Agent 任务状态/)
  expect(state.writes).toEqual([])
  expect(state.agentRequests.filter(item => item.method === 'POST')).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const taskStatus of ['unavailable', 'limited'] as const) {
  test(`audited manual application keeps employer link when task status is ${taskStatus}`, async ({ page }) => {
    const state = await install(page, taskStatus === 'unavailable' ? { taskFailure: true } : { taskLimited: true })
    await open(page)
    const drawer = page.getByRole('dialog')
    await expect(drawer.getByRole('button', { name: /Download application materials|下载申请材料/ })).toBeVisible()
    await expect(drawer.getByText(taskStatus === 'unavailable' ? /The latest task status is not available yet|暂时无法确认最新任务状态/ : /Showing recent application tasks, up to 100|显示最近最多100个申请任务/).first()).toBeVisible()
    const employer = drawer.getByRole('link', { name: /Open employer website|前往雇主网站/, exact: true })
    await expect(employer).toHaveAttribute('href', 'https://employer.invalid/apply')
    const popupPromise = page.waitForEvent('popup')
    await employer.click()
    await expect((await popupPromise).getByRole('heading', { name: 'Mock employer application' })).toBeVisible()
    await expect(drawer.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    expect(state.writes).toEqual([])
    expect(state.agentRequests.filter(item => item.method === 'POST')).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('unavailable task state does not expose a new preparation action', async ({ page }) => {
  const state = await install(page, { taskFailure: true })
  await open(page)
  await expect(page.getByText(/The latest task status is not available yet|暂时无法确认最新任务状态/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Prepare application materials|准备申请材料|Check current materials|检查当前材料/, exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const surface of ['jobs', 'dashboard'] as const) {
  test(`${surface} keeps the newer task status when an older read finishes last`, async ({ page }) => {
    const state = await install(page, { taskStatus: 'waiting_for_user', holdFirstTaskRead: true })
    try {
      await page.goto(`${origin}/?page=${surface}`)
      await expect.poll(() => state.taskReads).toBe(1)
      if (surface === 'jobs') await page.getByRole('button', { name: /Needs your attention|需要我处理/ }).click()
      state.taskStatusOverride = 'waiting_for_authorization'
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect.poll(() => state.taskReads).toBeGreaterThanOrEqual(2)
      const card = page.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })
      await expect(card).toContainText(/Review needed|等待审核/)
      await expect(card).not.toContainText(/Your input is needed|需要你补充信息/)
      const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/agent/application-tasks') && response.request().method() === 'GET')
      state.releaseFirstTaskRead()
      await oldResponse
      await expect.poll(() => state.firstTaskReadFinished).toBe(true)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(card).toContainText(/Review needed|等待审核/)
      await expect(card).not.toContainText(/Your input is needed|需要你补充信息/)
      expect(state.writes).toEqual([])
      expect(state.unexpected).toEqual([])
    } finally { state.releaseFirstTaskRead() }
  })
}

for (const surface of ['jobs', 'dashboard'] as const) {
  test(`${surface} keeps account B tasks after a delayed account A response`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'Exercises account switching')
    const state = await install(page, { taskStatus: 'waiting_for_user', holdFirstTaskRead: true, taskPerUser: true })
    try {
      await page.goto(`${origin}/?page=${surface}`)
      await expect.poll(() => state.taskReads).toBe(1)
      if (surface === 'jobs') await page.getByRole('button', { name: 'Needs your attention' }).click()
      state.activeUserId = 'fixture-b'
      await fixtureSession(page, 'authenticated', 'fixture-b')
      const card = page.getByRole('region', { name: 'Fixture B · Engineer B' })
      await expect(card).toContainText('Review needed')
      await expect.poll(() => state.taskReads).toBeGreaterThanOrEqual(2)
      const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/agent/application-tasks') && response.request().method() === 'GET')
      state.releaseFirstTaskRead()
      await oldResponse
      await expect.poll(() => state.firstTaskReadFinished).toBe(true)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(card).toContainText('Review needed')
      await expect(page.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })).toHaveCount(0)
      expect(state.writes).toEqual([])
      expect(state.unexpected).toEqual([])
    } finally { state.releaseFirstTaskRead() }
  })
}

for (const surface of ['jobs', 'dashboard'] as const) {
  test(`${surface} does not restore stale account A tasks while A reloads after B`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'Exercises account switching')
    const state = await install(page, { taskStatus: 'waiting_for_user', taskPerUser: true, holdReturnOwnerA: true })
    try {
      await page.goto(`${origin}/?page=${surface}`)
      if (surface === 'jobs') await page.getByRole('button', { name: 'Needs your attention' }).click()
      const firstCard = page.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })
      await expect(firstCard).toContainText('Your input is needed')
      state.activeUserId = 'fixture-b'
      await fixtureSession(page, 'authenticated', 'fixture-b')
      await expect(page.getByRole('region', { name: 'Fixture B · Engineer B' })).toContainText('Review needed')
      await expect(firstCard).toHaveCount(0)
      await page.evaluate(() => {
        const values: string[] = []
        ;(window as unknown as { __taskLeak: string[] }).__taskLeak = values
        const observer = new MutationObserver(records => {
          for (const record of records) for (const node of record.addedNodes) {
            if (node.textContent?.includes('Your input is needed')) values.push(node.textContent)
          }
          if (document.body.textContent?.includes('Your input is needed')) values.push('visible')
        })
        observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      })
      state.taskStatusOverride = 'waiting_for_authorization'
      state.armReturnOwnerA = true
      state.activeUserId = 'fixture-user'
      await fixtureSession(page, 'authenticated', 'fixture-user')
      await expect.poll(() => state.returnOwnerAEntered).toBe(true)
      await expect(firstCard).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Fixture B · Engineer B' })).toHaveCount(0)
      const leaks = await page.evaluate(() => (window as unknown as { __taskLeak: string[] }).__taskLeak)
      expect(leaks).toEqual([])
      state.releaseReturnOwnerA()
      await expect(firstCard).toContainText('Review needed')
      await expect(firstCard).not.toContainText('Your input is needed')
      expect(await page.evaluate(() => (window as unknown as { __taskLeak: string[] }).__taskLeak)).toEqual([])
      expect(state.writes).toEqual([])
      expect(state.unexpected).toEqual([])
    } finally { state.releaseReturnOwnerA() }
  })
}

test('dashboard opens all recent attention tasks without a duplicate continuation', async ({ page }) => {
  const state = await install(page, { dashboardFourTasks: true })
  await page.goto(`${origin}/?page=dashboard&highlight=stale-job`)
  const guidance = page.locator('.application-dashboard-guidance')
  await expect(guidance).toContainText(/Showing recent application tasks, up to 100.*not a complete application count|显示最近最多100个申请任务，不代表全部申请/)
  for (const n of [1, 2, 3]) await expect(guidance.getByRole('region', { name: `Employer ${n} · Role ${n}` })).toBeVisible()
  await expect(guidance).not.toContainText('Employer 4 · Role 4')
  await expect(guidance).not.toContainText(/Continue preparing this application|继续准备此申请|Follow-up due|待跟进/)
  await guidance.getByRole('button', { name: /View recent tasks needing attention|查看近期需要我处理的任务/ }).click()
  await expect(page).toHaveURL(/page=jobs/)
  await expect(page).toHaveURL(/jobsAttention=1/)
  expect(new URL(page.url()).searchParams.has('highlight')).toBe(false)
  const attention = page.getByRole('region', { name: /Needs your attention|需要我处理/ })
  await expect(attention).toContainText(/Showing recent application tasks, up to 100.*not a complete application count|显示最近最多100个申请任务，不代表全部申请/)
  for (const n of [1, 2, 3, 4]) await expect(attention.getByRole('region', { name: `Employer ${n} · Role ${n}` })).toBeVisible()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const staleRequested = state.staleJobRequested
  state.releaseStaleJob()
  if (staleRequested) await expect.poll(() => state.staleJobReturned).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(staleRequested).toBe(false)
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

test('a saved job changed to rejected without an applied date does not acquire a submission record', async ({ page }) => {
  const state = await install(page)
  await open(page)
  const submission = page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Submission record|提交记录/ })
  await expect(submission).toContainText(/Not confirmed|尚未确认/)
  expect(state.job.status).toBe('saved')
  expect(state.job.appliedAt).toBeNull()

  // Mirror the existing status PATCH: rejected sets workflowState to submitted,
  // even when there was never an appliedAt timestamp.
  state.job.status = 'rejected'
  state.job.workflowState = 'submitted'
  await page.reload()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  await expect(submission).toContainText(/Not confirmed|尚未确认/)
  await expect(page.getByText(/This application has a recorded result|此申请已有结果记录/)).toHaveCount(0)
  const history = page.getByRole('button', { name: /^(View application history|查看申请历史)$/ })
  await history.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: /^(Activity|活动记录)$/i })).toBeFocused()
  expect(state.job.appliedAt).toBeNull()
  expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(0)
  expect(state.unexpected).toEqual([])
})

test('a saved job with a historical applied date cannot be recorded again', async ({ page }) => {
  const state = await install(page)
  state.job.appliedAt = time
  await open(page)
  const submission = page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Submission record|提交记录/ })
  await expect(submission).toContainText(/Recorded|已有记录/)
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  expect(state.job.status).toBe('saved')
  expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(0)
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

test('resume preview is loading until the selected material is verified', async ({ page }) => {
  const state = await install(page, { holdResumeContent: true, recordedInitially: true })
  await open(page)
  await expect.poll(() => state.resumeContentRequested).toBe(true)
  const materials = page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Materials|申请材料/ })
  const submission = page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Submission record|提交记录/ })
  await expect(materials).toContainText(/Not confirmed|尚未确认/)
  await expect(submission).toContainText(/Recorded|已有记录/)
  await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  await expect(page.getByRole('status').filter({ hasText: /Loading resume|正在加载简历/ })).toBeVisible()
  const edit = page.getByRole('button', { name: /Edit this resume|编辑此简历/ })
  await expect(edit).toBeDisabled()
  state.releaseResumeContent()
  await expect(materials).toContainText(/Recorded|已有记录/)
  await expect(edit).toBeEnabled()
  await edit.click()
  await expect(page).toHaveURL(/page=resume/)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const previewCase of ['unavailable', 'owner', 'id', 'job'] as const) {
  test(`resume preview rejects unavailable or mismatched material: ${previewCase}`, async ({ page }) => {
    const state = await install(page, previewCase === 'unavailable' ? { evidenceCase: 'unavailable' } : { previewMismatch: previewCase })
    await open(page)
    await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
    await expect(page.getByRole('status').filter({ hasText: /Could not load resume|无法加载简历/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Edit this resume|编辑此简历/ })).toBeDisabled()
    const materials = page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Materials|申请材料/ })
    await expect(materials).toContainText(/Not confirmed|尚未确认/)
    if (previewCase === 'unavailable') {
      const review = page.getByRole('button', { name: /Provide missing information|补充信息/, exact: true })
      await expect(review).toBeEnabled()
      await review.click()
      await expect(page.getByText('Fixture evidence')).toBeVisible()
      expect(state.writes).toEqual([])
      await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
      state.hideResumeOnExport = false
      await page.getByRole('status').filter({ hasText: /Could not load resume|无法加载简历/ }).getByRole('button', { name: /Refresh status|刷新状态/ }).click()
      await expect(page.getByRole('button', { name: /Edit this resume|编辑此简历/ })).toBeEnabled()
      await expect(materials).toContainText(/Recorded|已有记录/)
    }
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

for (const malformedPreview of ['content', 'contact'] as const) test(`resume preview rejects missing ${malformedPreview} and recovers through a read-only refresh`, async ({ page }) => {
  const state = await install(page, { malformedPreview })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await open(page)
  await page.getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  const unavailable = page.getByRole('status').filter({ hasText: /Could not load resume|无法加载简历/ })
  await expect(unavailable).toBeVisible()
  const edit = page.getByRole('button', { name: /Edit this resume|编辑此简历/ })
  await expect(edit).toBeDisabled()
  state.malformedPreview = null
  await unavailable.getByRole('button', { name: /Refresh status|刷新状态/ }).click()
  await expect(edit).toBeEnabled()
  expect(errors).toEqual([])
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('a missing job description can be saved before preparation without starting AI', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, descriptionMode: 'success' })
  await open(page)
  const prepare = page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true })
  await expect(prepare).toBeDisabled()
  await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
  await page.getByLabel(/^(Job description|职位描述)$/).fill('Build reliable services using TypeScript and PostgreSQL.')
  expect(state.writes).toEqual([])
  expect(state.analysisRequests).toEqual([])
  const requestStart = state.requestOwners.length
  await page.getByRole('button', { name: /Save description|保存描述/, exact: true }).click()
  await expect.poll(() => state.writes.filter(write => write.path === '/api/jobs/outside-page')).toEqual([{ path: '/api/jobs/outside-page', body: { description: 'Build reliable services using TypeScript and PostgreSQL.', expectedEmptyDescription: '' } }])
  await expect(prepare).toBeEnabled()
  const requests = state.requestOwners.slice(requestStart)
  const auditRead = requests.findIndex(request => request.path.endsWith('/audit-application') && request.method === 'GET')
  const descriptionWrite = requests.findIndex(request => request.path === '/api/jobs/outside-page' && request.method === 'PATCH')
  expect(auditRead).toBeGreaterThanOrEqual(0)
  expect(descriptionWrite).toBeGreaterThan(auditRead)
  expect(state.analysisRequests).toEqual([])
  expect(state.writes).toHaveLength(1)
  expect(state.unexpected).toEqual([])
})

for (const initialDescription of [null, '', '  \n'] as const) {
  test(`description save preserves the exact empty server value ${JSON.stringify(initialDescription)}`, async ({ page }) => {
    const state = await install(page, { firstPreparation: true, descriptionMode: 'success', initialDescription })
    await open(page)
    await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
    await page.getByLabel(/^(Job description|职位描述)$/).fill('A complete job description.')
    await page.getByRole('button', { name: /Save description|保存描述/, exact: true }).click()
    await expect.poll(() => state.writes.filter(write => write.path === '/api/jobs/outside-page')).toEqual([
      { path: '/api/jobs/outside-page', body: { description: 'A complete job description.', expectedEmptyDescription: initialDescription } },
    ])
    await expect(page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true })).toBeEnabled()
    expect(state.unexpected).toEqual([])
  })
}

test('description conflict retains the draft and refresh only reads', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, descriptionMode: 'conflict' })
  await open(page)
  await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
  const draft = page.getByLabel(/^(Job description|职位描述)$/)
  await draft.fill('My preserved description draft.')
  await page.getByRole('button', { name: /Save description|保存描述/, exact: true }).click()
  await expect(page.getByText(/The job description changed before saving|职位描述在保存前已变化/)).toBeVisible()
  await expect(draft).toHaveValue('My preserved description draft.')
  await expect(draft).toHaveAttribute('readonly', '')
  await expect(page.getByRole('button', { name: /Save description|保存描述/, exact: true })).toHaveCount(0)
  const before = state.requestOwners.filter(request => request.path === '/api/jobs/outside-page' && request.method === 'GET').length
  await page.getByRole('button', { name: /Refresh status|刷新状态/, exact: true }).last().click()
  await expect.poll(() => state.requestOwners.filter(request => request.path === '/api/jobs/outside-page' && request.method === 'GET').length).toBeGreaterThan(before)
  await expect(page.getByText('Description from another session.', { exact: true })).toBeVisible()
  await expect(draft).toHaveValue('My preserved description draft.')
  expect(state.writes.filter(write => write.path === '/api/jobs/outside-page')).toHaveLength(1)
  expect(state.unexpected).toEqual([])
})

test('late description response preserves a newer job status and notes', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, descriptionMode: 'hold-response' })
  try {
    await open(page)
    await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
    await page.getByLabel(/^(Job description|职位描述)$/).fill('Description saved before a later status change.')
    await page.getByRole('button', { name: /Save description|保存描述/, exact: true }).click()
    await expect.poll(() => state.descriptionWriteStarted).toBe(true)
    const notes = page.getByPlaceholder(/Add notes, contacts|添加备注、联系人/)
    await notes.fill('More recent notes.')
    const notesResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'PATCH' && response.request().postDataJSON()?.notes === 'More recent notes.')
    await notes.press('Tab')
    expect((await (await notesResponse).json()).notes).toBe('More recent notes.')
    const recordResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page/apply') && response.request().method() === 'POST')
    const refreshedJob = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'GET' && state.manualPosted)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    expect(await (await recordResponse).json()).toEqual({ applied: true })
    expect(await (await refreshedJob).json()).toMatchObject({ id: 'outside-page', status: 'applied', workflowState: 'submitted', notes: 'More recent notes.' })
    await expect(page.getByText(/Application record|申请记录/, { exact: true })).toBeVisible()
    const descriptionResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'PATCH' && response.request().postDataJSON()?.description === 'Description saved before a later status change.')
    state.releaseDescription()
    const descriptionReply = await descriptionResponse
    expect(await descriptionReply.json()).toEqual({ id: 'outside-page', userId: 'fixture-user', description: 'Description saved before a later status change.' })
    await expect(page.getByLabel(/^(Job description|职位描述)$/)).toHaveCount(0)
    await expect(page.getByText('Description saved before a later status change.', { exact: true })).toBeVisible()
    await expect(page.getByText(/Application record|申请记录/, { exact: true })).toBeVisible()
    await expect(notes).toHaveValue('More recent notes.')
    expect(state.job).toMatchObject({ status: 'applied', workflowState: 'submitted', notes: 'More recent notes.', description: 'Description saved before a later status change.' })
    expect(state.unexpected).toEqual([])
  } finally { state.releaseDescription() }
})

for (const field of ['notes', 'followUp'] as const) {
  test(`late ${field} response preserves the newly saved description`, async ({ page }) => {
    const state = await install(page, { firstPreparation: true, descriptionMode: 'hold-other' })
    try {
      await open(page)
      const notes = page.getByPlaceholder(/Add notes, contacts|添加备注、联系人/)
      const date = page.getByRole('dialog').locator('input[type=date]')
      if (field === 'notes') {
        await notes.fill('Notes saved before description.')
        await notes.press('Tab')
      } else {
        await date.fill('2026-11-15')
        await date.evaluate(input => (input as HTMLInputElement).blur())
      }
      await expect.poll(() => state.otherJobUpdateStarted).toBe(true)
      await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
      await page.getByLabel(/^(Job description|职位描述)$/).fill('New description after another save.')
      await page.getByRole('button', { name: /Save description|保存描述/, exact: true }).click()
      await expect(page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true })).toBeEnabled()
      const otherResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'PATCH' && (field === 'notes' ? typeof response.request().postDataJSON()?.notes === 'string' : typeof response.request().postDataJSON()?.followUpAt === 'string'))
      state.releaseOtherJobUpdate()
      const earlierReply = await otherResponse
      const earlierBody = await earlierReply.json()
      expect(earlierBody.description).toBe('')
      if (field === 'notes') expect(earlierBody.notes).toBe('Notes saved before description.')
      else expect(earlierBody.followUpAt).toContain('2026-11-15')
      await expect(page.getByText(field === 'notes' ? /^(Notes saved|备注已保存)$/ : /^(Follow-up date set|跟进日期已设置)$/)).toBeVisible()
      await expect(page.getByText('New description after another save.', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true })).toBeEnabled()
      if (field === 'notes') await expect(notes).toHaveValue('Notes saved before description.')
      else await expect(date).toHaveValue('2026-11-15')
      expect(state.job.description).toBe('New description after another save.')
      if (field === 'notes') expect(state.job.notes).toBe('Notes saved before description.')
      else expect(state.job.followUpAt).toContain('2026-11-15')
      expect(state.unexpected).toEqual([])
    } finally { state.releaseOtherJobUpdate() }
  })
}

test('unconfirmed description save preserves the draft and refresh never repeats a write', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, descriptionMode: 'unknown' })
  await open(page)
  await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
  const description = page.getByLabel(/^(Job description|职位描述)$/)
  await description.fill('A locally retained job description for this role.')
  const save = page.getByRole('button', { name: /Save description|保存描述/, exact: true })
  await save.click()
  await expect(page.getByText(/The save result is unconfirmed|保存结果尚未确认/)).toBeVisible()
  await expect(description).toHaveValue('A locally retained job description for this role.')
  await expect(save).toHaveCount(0)
  const before = state.requestOwners.filter(request => request.path === '/api/jobs/outside-page' && request.method === 'GET').length
  await page.getByRole('button', { name: /Refresh status|刷新状态/, exact: true }).last().click()
  await expect.poll(() => state.requestOwners.filter(request => request.path === '/api/jobs/outside-page' && request.method === 'GET').length).toBeGreaterThan(before)
  await expect(description).toHaveValue('A locally retained job description for this role.')
  await expect(save).toHaveCount(0)
  expect(state.writes.filter(write => write.path === '/api/jobs/outside-page')).toHaveLength(1)
  expect(state.analysisRequests).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('an existing audit prevents adding a missing job description', async ({ page }) => {
  const state = await install(page, { descriptionMode: 'audit' })
  await open(page)
  await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
  await page.getByLabel(/^(Job description|职位描述)$/).fill('A proposed description requiring a fresh audit.')
  await page.getByRole('button', { name: /Save description|保存描述/, exact: true }).click()
  await expect(page.getByText(/An existing audit prevents adding a description here|此申请已有审核，暂不能在此补充职位描述/)).toBeVisible()
  await expect(page.getByLabel(/^(Job description|职位描述)$/)).toHaveValue('A proposed description requiring a fresh audit.')
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('a failed audit check retains an editable description until the user retries', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, descriptionMode: 'success' })
  const initialAudit = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'GET')
  await open(page)
  await (await initialAudit).finished()
  await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
  const description = page.getByLabel(/^(Job description|职位描述)$/)
  await description.fill('A description retained through a failed audit check.')
  state.failNextDescriptionAudit = true
  const save = page.getByRole('button', { name: /Save description|保存描述/, exact: true })
  await save.click()
  await expect(page.getByText(/Could not verify the application or audit|无法核实申请或审核状态/)).toBeVisible()
  await expect(description).toBeEditable()
  await expect(description).toHaveValue('A description retained through a failed audit check.')
  expect(state.writes).toEqual([])
  expect(state.analysisRequests).toEqual([])
  await save.click()
  await expect.poll(() => state.job.description).toBe('A description retained through a failed audit check.')
  expect(state.writes.filter(write => write.path === '/api/jobs/outside-page')).toHaveLength(1)
  expect(state.analysisRequests).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('existing job descriptions are not offered for editing', async ({ page }) => {
  const state = await install(page)
  await open(page)
  await expect(page.getByText('Build TypeScript services with PostgreSQL.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true })).toHaveCount(0)
  expect(state.writes).toEqual([])
})

for (const action of ['save', 'discard'] as const) {
  test(`description draft protects browser unload until ${action}`, async ({ page }) => {
    const state = await install(page, { firstPreparation: true, descriptionMode: 'success' })
    await open(page)
    await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
    await page.getByLabel(/^(Job description|职位描述)$/).fill('An unsaved local description.')
    const unloadPrevented = () => page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(await unloadPrevented()).toBe(true)
    await page.getByRole('button', { name: action === 'save' ? /Save description|保存描述/ : /Discard draft|丢弃草稿/, exact: true }).click()
    if (action === 'save') await expect.poll(() => state.job.description).toBe('An unsaved local description.')
    else await expect(page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true })).toBeVisible()
    await expect.poll(unloadPrevented).toBe(false)
    expect(state.writes.filter(write => write.path === '/api/jobs/outside-page')).toHaveLength(action === 'save' ? 1 : 0)
  })
}

test('job description drafts remain separate across jobs and accounts', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, descriptionMode: 'two' })
  await open(page)
  await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
  await page.getByLabel(/^(Job description|职位描述)$/).fill('Private draft for first job.')
  await page.getByRole('button', { name: /Close application details|关闭申请详情/ }).click()
  await page.getByText('Second fixture role', { exact: true }).first().click()
  await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
  await expect(page.getByLabel(/^(Job description|职位描述)$/)).toHaveValue('')
  await page.getByLabel(/^(Job description|职位描述)$/).fill('Private draft for second job.')
  await page.getByRole('button', { name: /Close application details|关闭申请详情/ }).click()
  await page.getByText('Application flow engineer', { exact: true }).first().click()
  const reopen = page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true })
  if (await reopen.count()) await reopen.click()
  await expect(page.getByLabel(/^(Job description|职位描述)$/)).toHaveValue('Private draft for first job.')
  state.activeUserId = 'fixture-b'
  await fixtureSession(page, 'authenticated', 'fixture-b')
  await expect(page.getByLabel(/^(Job description|职位描述)$/)).toHaveCount(0)
  state.activeUserId = 'fixture-user'
  await fixtureSession(page, 'authenticated')
  if (!(await page.getByRole('dialog').count())) await page.getByText('Application flow engineer', { exact: true }).first().click()
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  if (await reopen.count()) await reopen.click()
  await expect(page.getByLabel(/^(Job description|职位描述)$/)).toHaveValue('Private draft for first job.')
  expect(state.writes).toEqual([])
  expect(state.analysisRequests).toEqual([])
})

test('new job form does not offer a description or submit one', async ({ page }) => {
  const state = await install(page, { descriptionMode: 'success' })
  await page.goto(`${origin}/?page=jobs`)
  await page.getByRole('button', { name: /\+ Add job|\+ 添加职位/i }).first().click()
  const form = page.getByRole('dialog', { name: /Add job|添加职位/ })
  await form.getByLabel(/Company|公司/).fill('New Employer')
  await form.getByLabel(/Role|职位/).first().fill('New role')
  await expect(form.getByLabel(/^(Job description|职位描述)/)).toHaveCount(0)
  await form.getByRole('button', { name: /Add Job|添加职位/, exact: true }).click()
  await expect.poll(() => state.writes.find(write => write.path === '/api/jobs')).toMatchObject({ body: { company: 'New Employer', role: 'New role' } })
  const body = state.writes.find(write => write.path === '/api/jobs')?.body as Record<string, unknown>
  expect(body).not.toHaveProperty('description')
  expect(state.analysisRequests).toEqual([])
})

test('empty base resume list opens the resume library and returns to the same application', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, baseList: 'empty' })
  await open(page, '&jobsSearch=fixture')
  await expect(page.getByText(/Create or import a base resume|请先创建或导入基础简历/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true })).toBeDisabled()
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem
    Storage.prototype.removeItem = function (key: string) {
      if (this === sessionStorage && key === 'applymate:resume-return') throw new Error('Storage unavailable')
      return remove.call(this, key)
    }
  })
  await page.getByRole('button', { name: /Open resume library|打开简历库/ }).click()
  await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeVisible()
  const url = new URL(page.url())
  expect(url.searchParams.get('returnJobId')).toBe('outside-page')
  expect(url.searchParams.get('jobsSearch')).toBe('fixture')
  expect(url.searchParams.has('resumeId')).toBe(false)
  await page.getByRole('button', { name: /New Resume|新建简历/, exact: true }).click()
  await expect(page.getByPlaceholder(/Resume name|简历名称/)).toBeVisible()
  await page.getByRole('button', { name: /Cancel|取消/, exact: true }).click()
  await page.getByRole('button', { name: /Import & parse|导入并解析/ }).click()
  const intakeTitle = page.getByText(/Add your resume|添加你的简历/, { exact: true })
  await expect(intakeTitle).toBeVisible()
  await intakeTitle.locator('..').getByRole('button').click()
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  expect(new URL(page.url()).searchParams.get('jobsSearch')).toBe('fixture')
  expect(new URL(page.url()).searchParams.has('resumeStartEmpty')).toBe(false)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const method of ['create', 'import'] as const) {
  test(`application resume ${method} saves before returning to the same application`, async ({ page }) => {
    const state = await install(page, { firstPreparation: true, baseList: 'empty', holdBaseSave: true })
    try {
      await open(page, '&jobsSearch=fixture')
      await page.getByRole('button', { name: /Open resume library|打开简历库/ }).click()
      const back = page.getByRole('button', { name: /Back to this application|返回此申请/ })
      if (method === 'create') {
        await page.getByRole('button', { name: /New Resume|新建简历/, exact: true }).click()
        await expect(page.getByPlaceholder(/Resume name|简历名称/)).toBeVisible()
        expect(state.writes).toEqual([])
        await page.getByRole('button', { name: /Create|创建/, exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
      } else {
        await page.getByRole('button', { name: /Import & parse|导入并解析/ }).click()
        await page.getByRole('button', { name: /Paste text|粘贴文本/ }).click()
        await page.getByPlaceholder(/Paste your resume text|在这里粘贴简历文本/).fill('Fixture candidate with extensive software engineering and TypeScript experience for this test.')
        await page.getByRole('button', { name: /Parse resume|解析简历/ }).click()
        await page.getByRole('button', { name: /Save resume|保存简历/, exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
      }
      await expect.poll(() => state.baseSaveStarted).toBe(true)
      await expect(back).toBeDisabled()
      await back.evaluate(button => (button as HTMLButtonElement).click())
      expect(new URL(page.url()).searchParams.get('page')).toBe('resume')
      expect(state.writes.filter(write => write.path === '/api/resume')).toHaveLength(1)
      state.releaseBaseSave()
      await expect(back).toBeEnabled()
      expect(state.savedBase?.id).toBe('base-created')
      expect(state.savedBase?.content.summary).toBe(method === 'import' ? 'Software engineer.' : '')
      await back.click()
      await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
      await expect(page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true })).toBeEnabled()
      await expect(page.getByText(/Create or import a base resume|请先创建或导入基础简历/)).toHaveCount(0)
      expect(new URL(page.url()).searchParams.get('jobsSearch')).toBe('fixture')
      expect(state.writes.filter(write => write.path === '/api/resume')).toHaveLength(1)
      expect(state.unexpected).toEqual([])
    } finally { state.releaseBaseSave() }
  })
}

test('an unconfirmed base resume save is not retried automatically', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, baseList: 'empty', failBaseSave: true })
  await open(page)
  await page.getByRole('button', { name: /Open resume library|打开简历库/ }).click()
  await page.getByRole('button', { name: /New Resume|新建简历/, exact: true }).click()
  await page.getByRole('button', { name: /Create|创建/, exact: true }).click()
  await expect(page.getByText(/save result is unknown|保存结果未知/).first()).toBeVisible()
  await expect(page.getByText(/Save result unconfirmed|保存结果待核实/)).toBeVisible()
  await expect(page.getByText(/Save failed|保存失败/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /New Resume|新建简历/, exact: true })).toBeDisabled()
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  expect(state.writes.filter(write => write.path === '/api/resume')).toHaveLength(1)
})

for (const method of ['create', 'import'] as const) {
  test(`application resume ${method} deadline ignores a late save response`, async ({ page }) => {
    await page.clock.install()
    const state = await install(page, { firstPreparation: true, baseList: 'empty', holdBaseSave: true })
    try {
      await open(page)
      await page.getByRole('button', { name: /Open resume library|打开简历库/ }).click()
      if (method === 'create') {
        await page.getByRole('button', { name: /New Resume|新建简历/, exact: true }).click()
        await page.getByRole('button', { name: /Create|创建/, exact: true }).click()
      } else {
        await page.getByRole('button', { name: /Import & parse|导入并解析/ }).click()
        await page.getByRole('button', { name: /Paste text|粘贴文本/ }).click()
        await page.getByPlaceholder(/Paste your resume text|在这里粘贴简历文本/).fill('Fixture candidate with extensive software engineering and TypeScript experience for this test.')
        await page.getByRole('button', { name: /Parse resume|解析简历/ }).click()
        await page.getByRole('button', { name: /Save resume|保存简历/, exact: true }).click()
      }
      await expect.poll(() => state.baseSaveStarted).toBe(true)
      await page.clock.fastForward(30_001)
      await expect(page.getByText(/save result is unknown|保存结果未知/).first()).toBeVisible()
      await expect(page.getByText(/Save result unconfirmed|保存结果待核实/)).toBeVisible()
      await expect(page.getByText(/Save failed|保存失败/)).toHaveCount(0)
      const back = page.getByRole('button', { name: /Back to this application|返回此申请/ })
      await expect(back).toBeEnabled()
      if (method === 'import') await expect(page.getByRole('button', { name: /Save resume|保存简历/, exact: true })).toBeDisabled()
      else await expect(page.getByRole('button', { name: /New Resume|新建简历/, exact: true })).toBeDisabled()
      // The mocked server intentionally ignores cancellation and returns the successful response late.
      const lateResponse = page.waitForResponse(response => response.url().endsWith('/api/resume') && response.request().method() === 'POST' && response.status() === 200)
      state.releaseBaseSave()
      await (await lateResponse).finished()
      await page.waitForTimeout(200)
      await expect(page.getByText(/save result is unknown|保存结果未知/).first()).toBeVisible()
      await expect(page.locator('[data-resume-editor]')).toHaveCount(0)
      expect(state.savedBase?.id).toBe('base-created')
      expect(state.writes.filter(write => write.path === '/api/resume')).toHaveLength(1)
      if (method === 'import') await page.getByRole('button', { name: /Cancel|取消/, exact: true }).click()
      await back.click()
      await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
      expect(state.writes.filter(write => write.path === '/api/resume')).toHaveLength(1)
    } finally { state.releaseBaseSave() }
  })
}

test('the shell blocks browser back while a base resume creation is pending', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the real desktop shell navigation guard')
  const state = await install(page, { firstPreparation: true, baseList: 'empty', holdBaseSave: true })
  try {
    await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
    await page.getByRole('button', { name: 'Open resume library' }).click()
    await page.getByRole('button', { name: 'New Resume', exact: true }).click()
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect.poll(() => state.baseSaveStarted).toBe(true)
    await page.getByRole('button', { name: 'Applications', exact: true }).click()
    await expect(page).toHaveURL(/page=resume/)
    await page.evaluate(() => history.back())
    await page.waitForTimeout(300)
    await expect(page.getByRole('button', { name: /Back to this application/ })).toBeDisabled()
    await expect(page).toHaveURL(/page=resume/)
    expect(state.writes.filter(write => write.path === '/api/resume')).toHaveLength(1)
    state.releaseBaseSave()
    await expect(page.getByRole('button', { name: /Back to this application/ })).toBeEnabled()
    await page.getByRole('button', { name: /Back to this application/ }).click()
    await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  } finally { state.releaseBaseSave() }
})

test('direct resume entry retains its existing empty-library initialization', async ({ page }) => {
  const state = await install(page, { baseList: 'empty' })
  await page.goto(`${origin}/?page=resume`)
  await expect.poll(() => state.writes.filter(write => write.path === '/api/resume')).toHaveLength(1)
})

test('base resume loading and failure never claim an empty list and retry only reads', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, baseList: 'hold-empty' })
  try {
    await open(page)
    await expect(page.getByText(/Loading your resumes|正在加载你的简历/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Open resume library|打开简历库/ })).toHaveCount(0)
    expect(state.writes).toEqual([])
    state.releaseBaseList()
    await expect(page.getByText(/Create or import a base resume|请先创建或导入基础简历/)).toBeVisible()
  } finally { state.releaseBaseList() }
})

test('failed base resume list can be retried without a write', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, baseList: 'fail-once' })
  await open(page)
  const unavailable = page.getByRole('status').filter({ hasText: /Your resumes could not be loaded|无法加载简历，请刷新状态/ })
  await expect(unavailable).toBeVisible()
  await expect(page.getByRole('button', { name: /Open resume library|打开简历库/ })).toHaveCount(0)
  await unavailable.getByRole('button', { name: /Refresh status|刷新状态/ }).click()
  await expect(page.getByText(/Create or import a base resume|请先创建或导入基础简历/)).toBeVisible()
  expect(state.baseListReads).toBe(2)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('double retry of a failed base resume read shares one request', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, baseList: 'fail-once-hold' })
  try {
    await open(page)
    const unavailable = page.getByRole('status').filter({ hasText: /Your resumes could not be loaded|无法加载简历，请刷新状态/ })
    await expect(unavailable).toBeVisible()
    await unavailable.getByRole('button', { name: /Refresh status|刷新状态/ }).evaluate(button => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await expect.poll(() => state.baseListReads).toBe(2)
    await page.waitForTimeout(200)
    expect(state.baseListReads).toBe(2)
    expect(state.writes).toEqual([])
    state.releaseBaseList()
    await expect(page.getByText(/Create or import a base resume|请先创建或导入基础简历/)).toBeVisible()
    expect(state.unexpected).toEqual([])
  } finally { state.releaseBaseList() }
})

for (const mode of ['multiple', 'single', 'default'] as const) {
  test(`base resume ${mode} selection controls preparation`, async ({ page }) => {
    const state = await install(page, { firstPreparation: true, baseList: mode })
    await open(page)
    const prepare = page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true })
    if (mode === 'multiple') {
      const select = page.getByLabel(/Base resume|基础简历/)
      await expect(select).toHaveValue('')
      await expect(prepare).toBeDisabled()
      await select.selectOption('base-2')
    } else if (mode === 'default') await expect(page.getByLabel(/Base resume|基础简历/)).toHaveValue('base-1')
    await expect(prepare).toBeEnabled()
    await prepare.click()
    await expect.poll(() => state.writes.find(write => write.path.endsWith('/tailor-resume'))).toMatchObject({ body: { resumeId: mode === 'multiple' ? 'base-2' : 'base-1' } })
    expect(state.unexpected).toEqual([])
  })
}

test('first preparation stops after a generated resume cannot be read and reuses it after refresh', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, failTailoredRead: true })
  await open(page)
  const prepare = page.getByRole('button', { name: /Prepare application materials|准备申请材料|Check current materials|检查当前材料/, exact: true })
  await prepare.click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual(['/api/jobs/outside-page/tailor-resume'])
  await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
  const unavailable = page.getByRole('status').filter({ hasText: /Could not load resume|无法加载简历/ })
  await expect(unavailable).toBeVisible()
  await expect(prepare).toBeDisabled()
  expect(state.job.finalResumeId).toBeNull()
  state.hideResumeOnExport = false
  await unavailable.getByRole('button', { name: /Refresh status|刷新状态/ }).click()
  await expect(page.getByRole('button', { name: /Edit this resume|编辑此简历/ })).toBeEnabled()
  expect(state.writes.map(write => write.path)).toEqual(['/api/jobs/outside-page/tailor-resume'])
  await expect(prepare).toBeEnabled()
  await prepare.click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual([
    '/api/jobs/outside-page/tailor-resume', '/api/jobs/outside-page/audit-application', '/api/jobs/outside-page/assign',
  ])
  expect(state.unexpected).toEqual([])
})

test('a late generated resume read cannot continue preparation after its deadline', async ({ page }) => {
  await page.clock.install()
  const state = await install(page, { firstPreparation: true, holdResumeContent: true })
  await open(page)
  await page.getByRole('button', { name: /Prepare application materials|准备申请材料/, exact: true }).click()
  await expect.poll(() => state.resumeContentRequested).toBe(true)
  await page.clock.fastForward(30_001)
  await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
  state.releaseResumeContent()
  await expect(page.getByRole('button', { name: /Edit this resume|编辑此简历/ })).toBeEnabled()
  expect(state.writes.map(write => write.path)).toEqual(['/api/jobs/outside-page/tailor-resume'])
  expect(state.job.finalResumeId).toBeNull()
  expect(state.unexpected).toEqual([])
})

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

test('selected cover letter distinguishes loading and unavailable and refreshes without writes', async ({ page }) => {
  const state = await install(page, { holdSelectedLetter: true })
  await open(page)
  await expect.poll(() => state.letterRequested).toBe(true)
  const letterRow = page.getByRole('button').filter({ has: page.getByText(/^(Cover letter|求职信)$/) })
  await expect(letterRow).toContainText(/Loading cover letters|正在加载求职信/)
  await expect(letterRow).not.toContainText(/Not selected|未选择/)
  await letterRow.click()
  await expect(page.getByRole('status').filter({ hasText: /Loading cover letters|正在加载求职信/ })).toBeVisible()
  state.releaseLetters()
  const unavailable = page.getByRole('status').filter({ hasText: /selected cover letter could not be loaded.*selection is retained|无法加载已选求职信，原选择仍然保留/i })
  await expect(unavailable).toBeVisible()
  await expect(letterRow).not.toContainText(/Not selected|未选择/)
  expect(state.job.finalCoverLetterId).toBe('selected-letter')
  expect(state.writes).toEqual([])
  const reads = state.requestOwners.filter(request => request.path.endsWith('/cover-letters')).length
  await unavailable.getByRole('button', { name: /Refresh status|刷新状态/ }).click()
  await expect.poll(() => state.requestOwners.filter(request => request.path.endsWith('/cover-letters')).length).toBeGreaterThan(reads)
  await expect(unavailable).toBeVisible()
  expect(state.writes).toEqual([])
  state.selectedLetterAvailable = true
  await unavailable.getByRole('button', { name: /Refresh status|刷新状态/ }).click()
  await expect(page.getByRole('button', { name: /Open the full generated cover letter|打开完整生成求职信/ })).toBeVisible()
  expect(state.job.finalCoverLetterId).toBe('selected-letter')
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const letterInvalid of ['null', 'owner', 'job', 'duplicate', 'content'] as const) {
  test(`invalid selected letter is unavailable and recovers: ${letterInvalid}`, async ({ page }) => {
    const state = await install(page, { selectedLetter: true, letterInvalid })
    await open(page)
    const row = page.getByRole('button').filter({ has: page.getByText(/^(Cover letter|求职信)$/) })
    await row.click()
    const unavailable = page.getByRole('status').filter({ hasText: /selected cover letter could not be loaded.*selection is retained|无法加载已选求职信，原选择仍然保留/i })
    await expect(unavailable).toBeVisible()
    await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
    expect(state.job.finalCoverLetterId).toBe('selected-letter')
    expect(state.writes).toEqual([])
    state.invalidLetter = null
    await unavailable.getByRole('button', { name: /Refresh status|刷新状态/ }).click()
    await expect(page.getByRole('button', { name: /Open the full generated cover letter|打开完整生成求职信/ })).toBeVisible()
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('cover letter scope rejects superseded reads across refreshes, accounts, and jobs', async ({ page }) => {
  const state = await install(page, { letterRaceProbe: true })
  try {
    await page.goto(`${origin}/?page=letter-probe`)
    await expect.poll(() => state.probeLetterReads).toBe(1)
    await page.getByRole('button', { name: 'Probe refresh' }).click()
    await expect.poll(() => state.probeLetterReads).toBe(2)
    await page.getByRole('button', { name: 'Probe refresh' }).click()
    await expect.poll(async () => page.evaluate(() => (globalThis as typeof globalThis & { __fixtureLetterOutcomes?: string[] }).__fixtureLetterOutcomes ?? [])).toContain('superseded')
    await expect(page.getByTestId('letter-probe')).toHaveText('Current fixture letter 3')
    state.activeUserId = 'fixture-b'
    await page.getByRole('button', { name: 'Probe owner' }).click()
    await expect(page.getByTestId('letter-probe')).toHaveText('Current fixture letter 4')
    state.activeUserId = 'fixture-user'
    await page.getByRole('button', { name: 'Probe owner' }).click()
    await expect(page.getByTestId('letter-probe')).toHaveText('Current fixture letter 5')
    await page.getByRole('button', { name: 'Probe job' }).click()
    await expect(page.getByTestId('letter-probe')).toHaveText('Current fixture letter 6')
    await page.getByRole('button', { name: 'Probe job' }).click()
    await expect(page.getByTestId('letter-probe')).toHaveText('Current fixture letter 7')
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/cover-letters') && response.status() === 200)
    state.releaseProbeLetter()
    await oldResponse
    await expect(page.getByTestId('letter-probe')).toHaveText('Current fixture letter 7')
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseProbeLetter() }
})

test('an unselected cover letter remains optional and offers the selection path', async ({ page }) => {
  const state = await install(page)
  await open(page)
  const letterRow = page.getByRole('button').filter({ has: page.getByText(/^(Cover letter|求职信)$/) })
  await expect(letterRow).toContainText(/Not selected|未选择/)
  await letterRow.click()
  await expect(page.getByRole('button', { name: /Select or create a cover letter|选择或创建求职信/ })).toBeVisible()
  expect(state.job.finalCoverLetterId).toBeNull()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const letterAfterInitial of ['changed', 'failure'] as const) {
  test(`preparation stops if the selected cover letter refresh ${letterAfterInitial}`, async ({ page }) => {
    const state = await install(page, { selectedLetter: true, stale: true, letterAfterInitial })
    await open(page)
    await expect.poll(() => state.selectedLetterReads).toBe(1)
    const check = page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
    await expect(check).toBeEnabled()
    await check.click()
    await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
    expect(state.selectedLetterReads).toBe(2)
    expect(state.job.finalCoverLetterId).toBe('selected-letter')
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('switching accounts cancels an outstanding preparation read without auditing', async ({ page }) => {
  const state = await install(page, { selectedLetter: true, stale: true, letterAfterInitial: 'hold' })
  try {
    await open(page)
    await expect.poll(() => state.selectedLetterReads).toBe(1)
    await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
    await expect.poll(() => state.selectedLetterReads).toBe(2)
    state.activeUserId = 'fixture-b'
    await page.evaluate(() => (globalThis as typeof globalThis & { __fixtureSetSession: (status: string, id: string) => void }).__fixtureSetSession('authenticated', 'fixture-b'))
    await expect(page.getByRole('dialog', { name: 'Application flow engineer' })).toHaveCount(0)
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/cover-letters') && response.status() === 200)
    state.releaseProbeLetter()
    await oldResponse
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseProbeLetter() }
})

for (const phase of ['audit', 'assign'] as const) {
  test(`selected letter refresh during ${phase} prevents a stale ready result`, async ({ page }) => {
    const state = await install(page, { selectedLetter: true, stale: true, letterAfterInitial: 'manual-change', holdAudit: phase === 'audit', holdAssign: phase === 'assign' })
    try {
      await open(page)
      await expect.poll(() => state.selectedLetterReads).toBe(1)
      await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
      await expect.poll(() => phase === 'audit' ? state.auditStarted : state.assignStarted).toBe(true)
      const row = page.getByRole('button').filter({ has: page.getByText(/^(Cover letter|求职信)$/) })
      await row.click()
      state.changeLetterOnRead = true
      await page.getByRole('button', { name: /Refresh status|刷新状态/, exact: true }).click()
      await expect.poll(() => state.selectedLetterReads).toBe(3)
      await expect(page.getByRole('button', { name: /Open the full generated cover letter|打开完整生成求职信/ })).toBeVisible()
      if (phase === 'audit') state.releaseAudit(); else state.releaseAssign()
      await expect(page.getByText(/selected cover letter changed during preparation|所选求职信在准备期间发生变化/i)).toBeVisible()
      await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
      if (phase === 'audit') expect(state.writes.some(write => write.path.endsWith('/assign'))).toBe(false)
      else expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(1)
      expect(state.unexpected).toEqual([])
    } finally { state.releaseAudit(); state.releaseAssign() }
  })
}

for (const mode of ['audit-same', 'audit-failure', 'audit-hold'] as const) {
  test(`audit and selected-letter ${mode} refresh preserve safe preparation`, async ({ page }) => {
    const state = await install(page, { selectedLetter: true, stale: true, letterAfterInitial: mode, holdAudit: true })
    try {
      await open(page)
      await expect.poll(() => state.selectedLetterReads).toBe(1)
      await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
      await expect.poll(() => state.auditStarted).toBe(true)
      const row = page.getByRole('button').filter({ has: page.getByText(/^(Cover letter|求职信)$/) })
      await row.click()
      await page.getByRole('button', { name: /Refresh status|刷新状态/, exact: true }).click()
      await expect.poll(() => state.selectedLetterReads).toBe(3)
      if (mode === 'audit-same') {
        await expect(page.getByRole('button', { name: /Open the full generated cover letter|打开完整生成求职信/ })).toBeVisible()
      } else if (mode === 'audit-failure') {
        await expect(page.getByText(/selected cover letter could not be loaded.*selection is retained|无法加载已选求职信，原选择仍然保留/i).first()).toBeVisible()
      }
      const auditResponse = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'POST')
      state.releaseAudit()
      await auditResponse
      if (mode === 'audit-hold') {
        // Give the completed audit continuation an opportunity to run while the letter read remains gated.
        await page.waitForTimeout(400)
        expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
        state.releaseProbeLetter()
      }
      if (mode === 'audit-failure') {
        await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
        expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
        await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
      } else {
        await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toBeVisible()
        expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(1)
      }
      expect(state.writes.filter(write => write.path.endsWith('/audit-application'))).toHaveLength(1)
      expect(state.unexpected).toEqual([])
    } finally { state.releaseAudit(); state.releaseProbeLetter() }
  })
}

test('audit waits at most 30 seconds for a pending selected-letter refresh', async ({ page }) => {
  await page.clock.install()
  const state = await install(page, { selectedLetter: true, stale: true, letterAfterInitial: 'audit-hold', holdAudit: true })
  try {
    await open(page)
    await expect.poll(() => state.selectedLetterReads).toBe(1)
    await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
    await expect.poll(() => state.auditStarted).toBe(true)
    await page.getByRole('button').filter({ has: page.getByText(/^(Cover letter|求职信)$/) }).click()
    await page.getByRole('button', { name: /Refresh status|刷新状态/, exact: true }).click()
    await expect.poll(() => state.selectedLetterReads).toBe(3)
    const auditResponse = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'POST')
    state.releaseAudit()
    await auditResponse
    await page.clock.fastForward(30_001)
    await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
    expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
    await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/cover-letters') && response.status() === 200)
    state.releaseProbeLetter()
    await lateResponse
    await expect(page.getByText(/selected cover letter could not be loaded.*selection is retained|无法加载已选求职信，原选择仍然保留/i).first()).toBeVisible()
    expect(state.writes.filter(write => write.path.endsWith('/audit-application'))).toHaveLength(1)
    expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
    await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
    expect(state.unexpected).toEqual([])
  } finally { state.releaseAudit(); state.releaseProbeLetter() }
})

test('a selected letter and manual record arriving during a resume-only audit stop the old preparation', async ({ page }) => {
  const state = await install(page, { stale: true, holdAudit: true, externalLetterSelection: true })
  try {
    await open(page)
    await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
    await expect.poll(() => state.auditStarted).toBe(true)
    // A separate simulated actor selects the letter on the server while the audit is pending.
    const actorAssignment = await page.evaluate(async () => {
      const response = await fetch('/api/jobs/outside-page/assign', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finalCoverLetterId: 'selected-letter' }) })
      return { status: response.status, body: await response.json() }
    })
    expect(actorAssignment.status).toBe(200)
    expect(actorAssignment.body.finalCoverLetterId).toBe('selected-letter')
    expect(state.job.finalCoverLetterId).toBe('selected-letter')
    const recordResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page/apply') && response.request().method() === 'POST')
    const refreshedJob = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'GET' && state.manualPosted)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    expect(await (await recordResponse).json()).toEqual({ applied: true })
    expect(await (await refreshedJob).json()).toMatchObject({ id: 'outside-page', userId: 'fixture-user', status: 'applied', finalCoverLetterId: 'selected-letter' })
    await expect(page.getByText(/Application record|申请记录/, { exact: true })).toBeVisible()
    await page.getByRole('button').filter({ has: page.getByText(/^(Cover letter|求职信)$/) }).click()
    await expect(page.getByRole('button', { name: /Open the full generated cover letter|打开完整生成求职信/ })).toBeVisible()
    const auditResponse = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'POST')
    state.releaseAudit()
    await (await auditResponse).finished()
    await expect(page.getByText(/selected cover letter changed during preparation|所选求职信在准备期间发生变化/i)).toBeVisible()
    expect(state.writes.filter(write => write.path.endsWith('/assign'))).toEqual([{ path: '/api/jobs/outside-page/assign', body: { finalCoverLetterId: 'selected-letter' } }])
    await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
    expect(state.unexpected).toEqual([])
  } finally { state.releaseAudit() }
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

for (const scenario of [
  { name: 'resume version changed', version: 'resume-changed', letter: true, accepted: false },
  { name: 'cover letter version changed', version: 'letter-changed', letter: true, accepted: false },
  { name: 'resume version missing with a letter', version: 'resume-missing', letter: true, accepted: false },
  { name: 'cover letter version missing', version: 'letter-missing', letter: true, accepted: false },
  { name: 'resume version missing without a letter', version: 'resume-missing', letter: false, accepted: false },
  { name: 'both material versions match', version: 'same', letter: true, accepted: true },
] as const) {
  test(`audit response ${scenario.name} governs binding`, async ({ page }) => {
    const state = await install(page, { selectedLetter: scenario.letter, stale: true, auditVersion: scenario.version, holdAudit: true })
    try {
      await open(page)
      await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
      await expect.poll(() => state.auditStarted).toBe(true)
      expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
      state.releaseAudit()
      if (scenario.accepted) {
        await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toBeVisible()
        expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(1)
      } else {
        await expect(page.getByText(/audit could not be matched to the prepared material versions|无法确认审核所用版本与准备的材料一致/i)).toBeVisible()
        expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
        await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
      }
      expect(state.writes.filter(write => write.path.endsWith('/audit-application'))).toHaveLength(1)
      expect(state.unexpected).toEqual([])
    } finally { state.releaseAudit() }
  })
}

for (const outcome of ['get-fails', 'unknown'] as const) {
  test(`manual recording ${outcome} remains locked across status checks and reload`, async ({ page }) => {
    const state = await install(page, { manualOutcome: outcome })
    await open(page)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    await expect.poll(() => state.writes.filter(write => write.path.endsWith('/apply')).length).toBe(1)
    const refresh = page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
    await expect(refresh).toBeVisible()
    const title = page.getByText(outcome === 'unknown' ? /Check the record status|核实记录状态/ : /Record accepted; status updating|记录已接受，等待状态更新/)
    await expect(title).toBeVisible()
    const nextAction = page.locator('section').filter({ has: title })
    await expect(nextAction.getByRole('button', { name: /Refresh record status|刷新记录状态/ })).toHaveCount(1)
    await expect(nextAction.getByRole('button', { name: /Open employer website|前往雇主网站/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Open employer website|前往雇主网站/ })).toBeVisible()
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

test('unknown manual record stays locked when refresh sees rejected then saved', async ({ page }) => {
  const state = await install(page, { manualOutcome: 'unknown' })
  await open(page)
  await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
  await expect.poll(() => state.writes.filter(write => write.path.endsWith('/apply')).length).toBe(1)
  const refresh = page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
  await expect(refresh).toBeVisible()

  // The first POST has an unknown outcome. A different writer then changes
  // the status to rejected, and the status PATCH also sets workflowState.
  state.job.status = 'rejected'
  state.job.workflowState = 'submitted'
  const rejectedRead = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'GET')
  await refresh.click()
  const rejectedResponse = await rejectedRead
  expect(rejectedResponse.status()).toBe(200)
  expect(await rejectedResponse.json()).toMatchObject({ status: 'rejected', workflowState: 'submitted', appliedAt: null })
  await expect(page.getByText(/still unconfirmed|仍无法确认记录状态/)).toBeVisible()
  await expect(refresh).toBeVisible()
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)

  // A later status change back to saved cannot resolve the original POST.
  state.job.status = 'saved'
  state.job.workflowState = 'draft'
  const savedRead = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'GET')
  await refresh.click()
  const savedResponse = await savedRead
  expect(savedResponse.status()).toBe(200)
  expect(await savedResponse.json()).toMatchObject({ status: 'saved', workflowState: 'draft', appliedAt: null })
  await expect(page.getByText(/still unconfirmed|仍无法确认记录状态/)).toBeVisible()
  await expect(refresh).toBeVisible()
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  expect(state.job.appliedAt).toBeNull()
  expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(1)
  expect(state.unexpected).toEqual([])
})

test('a failed application history read can be retried without any write', async ({ page }) => {
  const state = await install(page)
  const reads: { jobId: string | null; limit: string | null }[] = []
  await page.route('**/api/activity?*', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    const url = new URL(route.request().url())
    reads.push({ jobId: url.searchParams.get('jobId'), limit: url.searchParams.get('limit') })
    if (reads.length === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture history unavailable' }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: 'fixture-history-1', userId: 'fixture-user', jobId: 'outside-page', type: 'status_changed',
      text: 'Fixture application history entry', color: null, createdAt: time,
      job: { company: 'Fixture Employer', role: 'Application flow engineer' },
    }]) })
  })
  await open(page)
  const failure = page.getByRole('status').filter({ hasText: /Application history could not be loaded|无法加载申请历史/ })
  await expect(failure).toBeVisible()
  await expect(page.getByText(/^(No activity yet|暂无活动记录)$/)).toHaveCount(0)
  expect(reads).toEqual([{ jobId: 'outside-page', limit: '20' }])
  const retry = failure.getByRole('button', { name: /^(Refresh status|刷新状态)$/ })
  await retry.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: /^(Activity|活动记录)$/i })).toBeFocused()
  await expect(page.getByText('Fixture application history entry', { exact: true })).toBeVisible()
  await expect(failure).toHaveCount(0)
  expect(reads).toEqual([{ jobId: 'outside-page', limit: '20' }, { jobId: 'outside-page', limit: '20' }])
  expect(state.writes).toEqual([])
  expect(state.analysisRequests).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const malformed of ['null', 'foreign-user', 'foreign-job', 'invalid-date'] as const) {
  test(`application history rejects ${malformed} data and can recover`, async ({ page }) => {
    const state = await install(page)
    const valid = { id: 'fixture-history-valid', userId: 'fixture-user', jobId: 'outside-page', type: 'status_changed',
      text: 'Valid fixture history', color: null, createdAt: time,
      job: { company: 'Fixture Employer', role: 'Application flow engineer' } }
    const invalid = malformed === 'null' ? null : { ...valid, text: 'Invalid fixture history',
      ...(malformed === 'foreign-user' ? { userId: 'other-user' } : {}),
      ...(malformed === 'foreign-job' ? { jobId: 'other-job' } : {}),
      ...(malformed === 'invalid-date' ? { createdAt: 'not-a-date' } : {}) }
    const reads: { jobId: string | null; limit: string | null }[] = []
    await page.route('**/api/activity?*', async route => {
      if (route.request().method() !== 'GET') return route.fallback()
      const url = new URL(route.request().url())
      reads.push({ jobId: url.searchParams.get('jobId'), limit: url.searchParams.get('limit') })
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([reads.length === 1 ? invalid : valid]) })
    })
    await open(page)
    const failure = page.getByRole('status').filter({ hasText: /Application history could not be loaded|无法加载申请历史/ })
    await expect(failure).toBeVisible()
    await expect(page.getByText(/^(No activity yet|暂无活动记录)$/)).toHaveCount(0)
    await expect(page.getByText('Invalid fixture history', { exact: true })).toHaveCount(0)
    await failure.getByRole('button', { name: /^(Refresh status|刷新状态)$/ }).click()
    await expect(page.getByText('Valid fixture history', { exact: true })).toBeVisible()
    await expect(failure).toHaveCount(0)
    expect(reads).toEqual([{ jobId: 'outside-page', limit: '20' }, { jobId: 'outside-page', limit: '20' }])
    expect(state.writes).toEqual([])
    expect(state.analysisRequests).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('successful manual record refreshes the current application history', async ({ page }) => {
  const state = await install(page)
  const reads: { jobId: string | null; limit: string | null; afterRecord: boolean }[] = []
  await page.route('**/api/activity?*', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    const url = new URL(route.request().url())
    reads.push({ jobId: url.searchParams.get('jobId'), limit: url.searchParams.get('limit'), afterRecord: state.manualPosted })
    const records = state.manualPosted ? [{ id: 'fixture-manual-history', userId: 'fixture-user', jobId: 'outside-page',
      type: 'applied', text: 'Fixture manual application recorded', color: null, createdAt: time,
      job: { company: 'Fixture Employer', role: 'Application flow engineer' } }] : []
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(records) })
  })
  await open(page)
  await expect(page.getByText(/^(No activity yet|暂无活动记录)$/)).toBeVisible()
  await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
  await expect(page.getByText('Fixture manual application recorded', { exact: true })).toBeVisible()
  expect(reads).toEqual([{ jobId: 'outside-page', limit: '20', afterRecord: false }, { jobId: 'outside-page', limit: '20', afterRecord: true }])
  expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(1)
  expect(state.writes).toHaveLength(1)
  expect(state.analysisRequests).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('retrying application history preserves interview preparation for the same job', async ({ page }) => {
  const state = await install(page)
  state.job.status = 'interview'
  state.job.workflowState = 'submitted'
  let historyReads = 0
  const prepCalls: unknown[] = []
  await page.route('**/api/activity?*', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    const url = new URL(route.request().url())
    expect(url.searchParams.get('jobId')).toBe('outside-page')
    historyReads += 1
    if (historyReads === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture history unavailable' }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: 'fixture-interview-history', userId: 'fixture-user', jobId: 'outside-page', type: 'interview_scheduled',
      text: 'Fixture interview scheduled', color: null, createdAt: time,
      job: { company: 'Fixture Employer', role: 'Application flow engineer' },
    }]) })
  })
  await page.route('**/api/ai/interview-prep', async route => {
    expect(route.request().method()).toBe('POST')
    prepCalls.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      questions: [{ question: 'Fixture interview question?', framework: 'Fixture interview answer framework.' }],
      companyResearch: 'Fixture company research.', followUpEmail: 'Fixture follow-up email.',
    }) })
  })
  await open(page)
  const failure = page.getByRole('status').filter({ hasText: /Application history could not be loaded|无法加载申请历史/ })
  await expect(failure).toBeVisible()
  await page.getByRole('button', { name: /^(Generate Interview Prep|生成面试准备)$/ }).click()
  await expect(page.getByText('Fixture interview question?', { exact: false })).toBeVisible()
  await expect(page.getByText('Fixture company research.', { exact: true })).toBeVisible()
  expect(prepCalls).toEqual([{ jobTitle: state.job.role, jobCompany: state.job.company, jobDescription: state.job.description }])

  await failure.getByRole('button', { name: /^(Refresh status|刷新状态)$/ }).click()
  await expect(page.getByText('Fixture interview scheduled', { exact: true })).toBeVisible()
  await expect(page.getByText('Fixture interview question?', { exact: false })).toBeVisible()
  await expect(page.getByText('Fixture company research.', { exact: true })).toBeVisible()
  expect(historyReads).toBe(2)
  expect(prepCalls).toHaveLength(1)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('a visible submission record does not resolve an unknown manual recording request', async ({ page }) => {
  const state = await install(page, { manualOutcome: 'unknown' })
  await open(page)
  await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
  await expect.poll(() => state.writes.filter(write => write.path.endsWith('/apply')).length).toBe(1)
  const refresh = page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
  await expect(refresh).toBeVisible()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('unknown')

  // A later read can find a record, but cannot establish whether this
  // particular request or a concurrent writer created it.
  Object.assign(state.job, { status: 'applied', workflowState: 'submitted', appliedAt: time })
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'GET')
  await refresh.click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'applied', workflowState: 'submitted', appliedAt: time })
  await expect(page.getByText(/A submission record exists, but this request is still unconfirmed|已有提交记录，但仍无法确认是否由本次请求产生/)).toBeVisible()
  await expect(page.getByText(/Check the record status|核实记录状态/)).toBeVisible()
  const submission = page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Submission record|提交记录/ })
  await expect(submission).toContainText(/Recorded|已有记录/)
  await expect(refresh).toBeVisible()
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  expect(await page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('unknown')
  expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(1)
  expect(state.unexpected).toEqual([])
})

test('late manual record status read cannot overwrite a newer description or unlock an unknown outcome', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, descriptionMode: 'success', manualOutcome: 'unknown' })
  let releaseManualRead = () => {}
  const manualReadGate = new Promise<void>(resolve => { releaseManualRead = resolve })
  let manualReadEntered = false
  let heldSnapshot: typeof state.job | null = null
  try {
    await open(page)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    await expect.poll(() => state.writes.filter(write => write.path.endsWith('/apply')).length).toBe(1)
    const refresh = page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
    await expect(refresh).toBeVisible()

    // The POST response was lost, but the mocked server later reflects that
    // it committed. Capture this older Job before the description update.
    Object.assign(state.job, { status: 'applied', workflowState: 'submitted', appliedAt: time })
    await page.route('**/api/jobs/outside-page', async route => {
      if (route.request().method() === 'GET' && !manualReadEntered) {
        heldSnapshot = { ...state.job }
        manualReadEntered = true
        await manualReadGate
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(heldSnapshot) })
      }
      return route.fallback()
    })
    await refresh.click()
    await expect.poll(() => manualReadEntered).toBe(true)
    expect(heldSnapshot).toMatchObject({ status: 'applied', workflowState: 'submitted', appliedAt: time, description: '' })

    // A newer user action finishes while the earlier read remains in flight.
    await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
    await page.getByLabel(/^(Job description|职位描述)$/).fill('Newer description after the status read began.')
    const savedDescription = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'PATCH')
    await page.getByRole('button', { name: /Save description|保存描述/, exact: true }).click()
    expect((await savedDescription).status()).toBe(200)
    await expect(page.getByLabel(/^(Job description|职位描述)$/)).toHaveCount(0)
    await expect(page.getByText('Newer description after the status read began.', { exact: true })).toBeVisible()
    expect(state.job.description).toBe('Newer description after the status read began.')

    const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'GET')
    releaseManualRead()
    expect(await (await oldResponse).json()).toMatchObject({ status: 'applied', appliedAt: time, description: '' })
    await expect(page.getByText('Newer description after the status read began.', { exact: true })).toBeVisible()
    await expect(refresh).toBeEnabled()
    await expect(page.getByText(/A submission record exists, but this request is still unconfirmed|已有提交记录，但仍无法确认是否由本次请求产生/)).toHaveCount(0)
    await expect(refresh).toBeVisible()
    await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(1)
    expect(state.writes.filter(write => write.path === '/api/jobs/outside-page')).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  } finally { releaseManualRead() }
})

test('late automatic status read after a successful manual record preserves a newer description', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, descriptionMode: 'success' })
  let releaseManualRead = () => {}
  const manualReadGate = new Promise<void>(resolve => { releaseManualRead = resolve })
  let manualReadEntered = false
  let heldSnapshot: typeof state.job | null = null
  try {
    await open(page)
    // Only the first post-submit read is delayed; later reads for the
    // description preflight and an explicit refresh use the current Job.
    await page.route('**/api/jobs/outside-page', async route => {
      if (route.request().method() === 'GET' && state.manualPosted && !manualReadEntered) {
        heldSnapshot = { ...state.job }
        manualReadEntered = true
        await manualReadGate
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(heldSnapshot) })
      }
      return route.fallback()
    })
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    await expect.poll(() => manualReadEntered).toBe(true)
    expect(heldSnapshot).toMatchObject({ status: 'applied', workflowState: 'submitted', appliedAt: time, description: '' })

    await page.getByRole('button', { name: /Add job description|补充职位描述/, exact: true }).click()
    await page.getByLabel(/^(Job description|职位描述)$/).fill('Description saved after the automatic read began.')
    const savedDescription = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'PATCH')
    await page.getByRole('button', { name: /Save description|保存描述/, exact: true }).click()
    expect((await savedDescription).status()).toBe(200)
    await expect(page.getByLabel(/^(Job description|职位描述)$/)).toHaveCount(0)
    await expect(page.getByText('Description saved after the automatic read began.', { exact: true })).toBeVisible()

    const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'GET')
    releaseManualRead()
    expect(await (await oldResponse).json()).toMatchObject({ status: 'applied', appliedAt: time, description: '' })
    await expect(page.getByText('Description saved after the automatic read began.', { exact: true })).toBeVisible()

    const refresh = page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
    await expect(refresh).toBeEnabled()
    const currentResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs/outside-page') && response.request().method() === 'GET')
    await refresh.click()
    expect(await (await currentResponse).json()).toMatchObject({ status: 'applied', description: 'Description saved after the automatic read began.' })
    await expect(page.getByText('Description saved after the automatic read began.', { exact: true })).toBeVisible()
    const submission = page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Submission record|提交记录/ })
    await expect(submission).toContainText(/Recorded|已有记录/)
    await expect(refresh).toHaveCount(0)
    expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(1)
    expect(state.writes.filter(write => write.path === '/api/jobs/outside-page')).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  } finally { releaseManualRead() }
})


async function pdfText(bytes: Buffer): Promise<string> {
  const webRequire = createRequire(path.resolve(__dirname, '../apps/web/package.json'))
  const parser = webRequire.resolve('pdf-parse')
  return new Promise((resolve, reject) => {
    const script = `const parse=require(process.argv[1]);const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{const raw=Buffer.concat(chunks);const exact=Uint8Array.from(raw);parse(exact).then(result=>process.stdout.write(result.text)).catch(error=>{console.error(error);process.exitCode=1})})`
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
  const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST')
  await page.getByTitle(/Save to My Jobs|保存到我的职位/).click()
  const savedJob = await (await saveResponse).json()
  expect(savedJob.id).toBe(state.job.id)
  await expect.poll(() => state.writes.filter(item => item.path === '/api/jobs').length).toBe(1)
  const view = page.getByRole('button', { name: /View this application|查看此申请/ }).first()
  await expect(view).toBeVisible()
  const readResponse = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${savedJob.id}`) && response.request().method() === 'GET')
  await view.click()
  expect((await (await readResponse).json()).id).toBe(savedJob.id)
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
    await expect(page.getByText(/resume save is unconfirmed|简历保存结果待核实/i).first()).toBeVisible()
    await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Second resume content.', { exact: false })).toHaveCount(0)
    expect(state.writes.every(item => item.path === '/api/resume/resume-1')).toBe(true)
    expect(state.unexpected).toEqual([])
    // A failed response does not prove that the write did not commit.
    await page.waitForTimeout(2300)
    expect(state.saveResponses).toBe(1)
    await expect(page.getByText('Edited fixture summary', { exact: false }).first()).toBeVisible()
    expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(true)
    expect(state.writes.every(item => item.path === '/api/resume/resume-1')).toBe(true)
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
  test(pending === 'resume GET' ? 'audit correction waits for current resume verification' : 'audit correction survives an older analysis response', async ({ page }, testInfo) => {
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
      if (pending === 'resume GET') {
        expect(state.writes.map(write => write.path)).not.toContain('/api/jobs/outside-page/audit-application/apply')
        const currentRead = page.waitForResponse(response => response.url().endsWith('/api/resume/resume-1') && response.request().method() === 'GET')
        state.releaseResumeContent()
        await (await currentRead).finished()
        await page.getByRole('button', { name: 'Apply generated fix', exact: true }).click()
      }
      await expect.poll(() => state.writes.map(write => write.path)).toContain('/api/jobs/outside-page/audit-application/apply')
      await expect(page.locator('[data-resume-editor]').getByText('Audited v2 summary', { exact: false }).first()).toBeVisible()
      await expect.poll(() => page.evaluate(() => {
        const read = (window as unknown as { __fixtureGetCachedResume: () => { updatedAt?: string; content?: { summary?: string } } | null }).__fixtureGetCachedResume
        return read()
      })).toMatchObject({ updatedAt: newTime, content: { summary: 'Audited v2 summary' } })
      if (pending === 'analysis') {
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


test('opening the related Agent session does not read a stale session from the URL', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the real desktop Agent shell')
  const state = await install(page, { taskStatus: 'waiting_for_authorization', realAgent: true })
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page&sessionId=stale-session`)
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  await page.getByRole('link', { name: 'Review in Agent' }).click()
  await expect(page).toHaveURL(/sessionId=original-session/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  await expect(page.locator('[data-agent-approval-ledger="true"]')).toBeVisible()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(state.agentRequests.some(item => item.path.startsWith('/api/agent/sessions/stale-session'))).toBe(false)
  expect(state.agentRequests.filter(item => item.method === 'POST')).toEqual([])
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
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


test('expired approval remains in the original session without a decision or submission', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the real desktop Agent shell')
  const state = await install(page, { taskStatus: 'waiting_for_authorization', realAgent: true, expiredApproval: true })
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  await page.getByRole('link', { name: 'Review in Agent' }).click()
  await expect(page).toHaveURL(/sessionId=original-session/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  const ledger = page.locator('[data-agent-approval-ledger="true"]')
  await expect(ledger).toContainText('Expired')
  await expect(ledger).toContainText('Pending decisions')
  await expect(ledger).toContainText('0')
  await expect(ledger.getByRole('button', { name: /^(Approve|Reject)$/ })).toHaveCount(0)
  expect(state.agentRequests.filter(item => item.method === 'POST')).toEqual([])
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
  await expect(page.getByText(/resume save is unconfirmed|简历保存结果待核实/i).first()).toBeVisible()
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


test('identical questions on two applications remain scoped to their original sessions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the real desktop Agent shell')
  const state = await install(page, { realAgent: true, twoJobQuestions: true })
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  await page.getByRole('link', { name: 'Answer in the original task' }).click()
  await expect(page).toHaveURL(/sessionId=session-a/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  const first = page.locator('[data-agent-question-card="true"]')
  await expect(first).toContainText('Confirm the same fixture fact?')
  await first.getByRole('button', { name: 'Yes', exact: true }).click()
  await first.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect.poll(() => state.answeredJobA).toBe(true)
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=job-2`)
  await expect(page.getByRole('dialog')).toContainText('Employer B')
  await page.getByRole('link', { name: 'Answer in the original task' }).click()
  await expect(page).toHaveURL(/sessionId=session-b/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  const second = page.locator('[data-agent-question-card="true"]')
  await expect(second).toContainText('Confirm the same fixture fact?')
  await expect(second.getByRole('button', { name: 'Yes', exact: true })).toBeEnabled()
  await expect(second.getByRole('button', { name: 'Send answer', exact: true })).toBeVisible()
  const posts = state.agentRequests.filter(item => item.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ path: '/api/agent/sessions/session-a/questions/question-a', body: { expectedTurnId: 'turn-a', expectedRevision: 1, answer: 'yes' } })
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
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
  // The fixture changes the same task's state. Return through the real UI to
  // verify the previous question is replaced by the next actionable review.
  await page.locator('#desktop-sidebar').getByRole('button', { name: 'Dashboard', exact: true }).click()
  const guidance = page.locator('.application-dashboard-guidance')
  const taskCard = guidance.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })
  await expect(taskCard).toContainText('Review needed')
  await expect(taskCard).not.toContainText('Your input is needed')
  await taskCard.getByRole('link', { name: 'Review in Agent' }).click()
  await expect(page).toHaveURL(/sessionId=original-session/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  const approval = page.locator('[data-agent-approval-ledger="true"]')
  await expect(approval).toBeVisible()
  await approval.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(() => state.agentStage).toBe('running')
  expect(state.agentRequests.filter(item => item.method === 'POST')[1]).toMatchObject({ path: '/api/agent/sessions/original-session/approvals/fixture-approval', body: { expectedTurnId: 'fixture-turn', expectedRevision: 2, decision: 'approved' } })
  // After approval the same task is running, so neither the old question nor
  // approval should remain in the bounded attention view.
  await page.locator('#desktop-sidebar').getByRole('button', { name: /^Applications(?:\s+\d+)?$/ }).click()
  await page.getByRole('button', { name: 'Needs your attention', exact: true }).click()
  const attention = page.getByRole('region', { name: 'Needs your attention' })
  await expect(attention).toContainText('No recent tasks need your attention.')
  await expect(attention).not.toContainText('Fixture Employer · Application flow engineer')
  await page.locator('#desktop-sidebar').getByRole('button', { name: 'Agent', exact: true }).click()
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

for (const denial of ['limit', 'plan'] as const) {
  test(`manual record ${denial} rejection explains the limit and requires a fresh check`, async ({ page }) => {
    const state = await install(page)
    let posts = 0
    await page.route('**/api/jobs/outside-page/apply', async route => {
      posts += 1
      if (posts === 1) return route.fulfill({ status: 403, json: {
        code: denial === 'limit' ? 'MANUAL_APPLICATION_LIMIT_REACHED' : 'MANUAL_APPLICATION_PLAN_RESTRICTED',
        requestId: route.request().headers()['x-manual-record-request-id'],
      } })
      Object.assign(state.job, { status: 'applied', workflowState: 'submitted', appliedAt: time })
      return route.fulfill({ status: 200, json: { applied: true } })
    })
    await open(page)
    const record = page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })
    await record.click()
    await expect(page.getByText(denial === 'limit' ? /record was not saved because your monthly application limit|本次记录未保存，因为本月申请额度已用完/ : /record was not saved because manual applications are unavailable|本次记录未保存，因为当前套餐暂不可使用手动申请/)).toBeVisible()
    const nextAction = page.locator('section').filter({ has: page.getByText(/Manual record not saved|手动记录未保存/) })
    await expect(nextAction.getByRole('button', { name: /Refresh status|刷新状态/ })).toHaveCount(1)
    await expect(nextAction.getByRole('button', { name: /Open employer website|前往雇主网站/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Open employer website|前往雇主网站/ })).toBeVisible()
    await expect(record).toHaveCount(0)
    expect(posts).toBe(1)
    await open(page)
    await expect(page.getByText(denial === 'limit' ? /record was not saved because your monthly application limit|本次记录未保存，因为本月申请额度已用完/ : /record was not saved because manual applications are unavailable|本次记录未保存，因为当前套餐暂不可使用手动申请/)).toBeVisible()
    await expect(record).toHaveCount(0)
    await page.getByRole('button', { name: /Refresh status|刷新状态/ }).last().click()
    await expect(record).toBeVisible()
    expect(posts).toBe(1)
    await open(page)
    await expect(record).toHaveCount(0)
    await page.getByRole('button', { name: /Refresh status|刷新状态/ }).last().click()
    await expect(record).toBeVisible()
    await record.click()
    await expect.poll(() => posts).toBe(2)
    await expect(page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Submission record|提交记录/ })).toContainText(/Recorded|已有记录/)
    expect(state.unexpected).toEqual([])
  })
}

test('an unverified quota response never releases an uncertain manual record', async ({ page }) => {
  const state = await install(page)
  let posts = 0
  await page.route('**/api/jobs/outside-page/apply', async route => {
    posts += 1
    return route.fulfill({ status: 403, json: { code: 'MANUAL_APPLICATION_LIMIT_REACHED', requestId: 'other-request' } })
  })
  await open(page)
  await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
  await expect(page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  expect(await page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('unknown')
  expect(posts).toBe(1)
  expect(state.unexpected).toEqual([])
})

test('an active task remains the primary action while an older manual record is unknown', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('applymate:manual-record:fixture-user:outside-page', 'unknown'))
  const state = await install(page, { taskStatus: 'waiting_for_user' })
  await open(page)
  await expect(page.getByText(/Check the record status|核实记录状态/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(0)
  expect(state.unexpected).toEqual([])
})

test('a rejected manual record stays blocked when refresh fails or finds a later record', async ({ page }) => {
  const state = await install(page)
  let posts = 0
  let failRead = false
  await page.route('**/api/jobs/outside-page/apply', async route => {
    posts += 1
    return route.fulfill({ status: 403, json: { code: 'MANUAL_APPLICATION_LIMIT_REACHED', requestId: route.request().headers()['x-manual-record-request-id'] } })
  })
  await page.route('**/api/jobs/outside-page', async route => {
    if (route.request().method() === 'GET' && failRead) return route.fulfill({ status: 500, json: { error: 'unavailable' } })
    return route.fallback()
  })
  await open(page)
  const record = page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })
  await record.click()
  await expect(record).toHaveCount(0)
  failRead = true
  await page.getByRole('button', { name: /Refresh status|刷新状态/ }).last().click()
  await expect(page.getByText(/Could not refresh the application|无法刷新申请/)).toBeVisible()
  await expect(record).toHaveCount(0)
  failRead = false
  Object.assign(state.job, { status: 'applied', workflowState: 'submitted', appliedAt: time })
  await page.getByRole('button', { name: /Refresh status|刷新状态/ }).last().click()
  await expect(page.getByRole('list', { name: /Application progress|申请进度/ }).locator('li').filter({ hasText: /Submission record|提交记录/ })).toContainText(/Recorded|已有记录/)
  await expect(record).toHaveCount(0)
  expect(posts).toBe(1)
  expect(state.unexpected).toEqual([])
})

test('a stalled manual recording becomes unknown and can be checked without a second POST', async ({ page }) => {
  const state = await install(page)
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let posts = 0
  await page.route('**/api/jobs/outside-page/apply', async route => {
    posts += 1
    await gate
    await route.fulfill({ status: 200, json: { applied: true } }).catch(() => undefined)
  })
  try {
    await open(page)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    const refresh = page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
    await expect(refresh).toBeEnabled({ timeout: 25_000 })
    expect(await page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('unknown')
    await refresh.click()
    await expect(refresh).toBeEnabled()
    release()
    await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    expect(posts).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('a stalled record-status read returns control without accepting a late response', async ({ page }) => {
  const state = await install(page, { manualOutcome: 'unknown' })
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let holdRead = false
  let entered = false
  await page.route('**/api/jobs/outside-page', async route => {
    if (route.request().method() !== 'GET' || !holdRead) return route.fallback()
    entered = true
    await gate
    await route.fulfill({ status: 200, json: { ...state.job, status: 'applied', workflowState: 'submitted', appliedAt: time } }).catch(() => undefined)
  })
  try {
    await open(page)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    const refresh = page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
    await expect(refresh).toBeEnabled()
    holdRead = true
    await refresh.click()
    await expect.poll(() => entered).toBe(true)
    await expect(refresh).toBeEnabled({ timeout: 25_000 })
    release()
    await expect(page.getByText(/A submission record exists, but this request is still unconfirmed|已有提交记录，但仍无法确认是否由本次请求产生/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

for (const previousTaskState of ['unavailable', 'limited'] as const) {
  test(`refreshing an unknown manual record also recovers ${previousTaskState} task state`, async ({ page }) => {
    const state = await install(page, { manualOutcome: 'unknown' })
    let phase = 0
    let taskReads = 0
    await page.route('**/api/agent/application-tasks**', async route => {
      taskReads += 1
      if (phase === 0) return route.fulfill({ status: 200, json: { tasks: [] } })
      if (phase === 1 && previousTaskState === 'unavailable') return route.fulfill({ status: 500, json: { error: 'unavailable' } })
      if (phase === 1) return route.fulfill({ status: 200, json: { tasks: Array.from({ length: 100 }, (_, index) => ({
        id: `other-task-${index}`, userId: 'fixture-user', jobId: `other-job-${index}`, sessionId: `other-session-${index}`,
        status: 'filling', checkpoint: null, updatedAt: time, job: { company: 'Other employer', role: 'Other role' },
      })) } })
      return route.fulfill({ status: 200, json: { tasks: [{ id: 'task-1', userId: 'fixture-user', jobId: 'outside-page',
        sessionId: 'original-session', status: 'waiting_for_user', checkpoint: 'form_answer_required', updatedAt: time,
        job: { company: 'Fixture Employer', role: 'Application flow engineer' } }] } })
    })
    await open(page)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    await expect.poll(() => state.writes.filter(write => write.path.endsWith('/apply')).length).toBe(1)
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('unknown')
    phase = 1
    const failureRead = page.waitForResponse(response => response.url().includes('/api/agent/application-tasks'))
    await open(page)
    await failureRead
    expect(taskReads).toBeGreaterThanOrEqual(2)
    phase = 2
    const recoveredRead = page.waitForResponse(response => response.url().includes('/api/agent/application-tasks'))
    await page.getByRole('button', { name: /Refresh record status|刷新记录状态/ }).click()
    await recoveredRead
    const task = page.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })
    await expect(task).toBeVisible()
    await expect(task.locator('a')).toHaveAttribute('href', /original-session/)
    await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    expect(await page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('unknown')
    expect(state.writes.filter(write => write.path.endsWith('/apply'))).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  })
}

for (const result of ['confirmed', 'rejected'] as const) {
  test(`a malformed ${result} record-status response preserves the application context`, async ({ page }) => {
    const state = await install(page)
    let posts = 0
    let malformed = false
    await page.route('**/api/jobs/outside-page/apply', async route => {
      posts += 1
      malformed = true
      if (result === 'rejected') return route.fulfill({ status: 403, json: { code: 'MANUAL_APPLICATION_LIMIT_REACHED', requestId: route.request().headers()['x-manual-record-request-id'] } })
      return route.fulfill({ status: 200, json: { applied: true } })
    })
    await page.route('**/api/jobs/outside-page', async route => {
      if (route.request().method() !== 'GET' || !malformed) return route.fallback()
      return route.fulfill({ status: 200, json: { id: 'outside-page', userId: 'fixture-user', updatedAt: time, status: 'applied' } })
    })
    await open(page)
    await page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ }).click()
    const refresh = result === 'rejected' ? page.getByRole('button', { name: /Refresh status|刷新状态/ }).first() : page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })
    await expect(refresh).toBeEnabled()
    await refresh.click()
    await expect(page.getByText(result === 'rejected' ? /Could not refresh the application|无法刷新申请/ : /record status is still unconfirmed|仍无法确认记录状态/)).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Application flow engineer' })).toContainText('Fixture Employer')
    await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    expect(posts).toBe(1)
    expect(state.unexpected).toEqual([])
  })
}
