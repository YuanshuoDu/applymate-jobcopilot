import { expect, test, type Page, type Route } from '@playwright/test'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { createHash, randomInt } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AUDIT_LIMIT_MESSAGES } from '../apps/web/src/lib/application-audit-limits'

// Mounted production components with mocked identity/API responses. This is not
// proof of authentication, database behavior, Agent execution or real submission.
// Keep failure screenshots and retry traces without recording every successful
// case twice; the full matrix otherwise exceeds its CI time limit.
test.use({ screenshot: 'only-on-failure', trace: 'on-first-retry' })
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
      import {CoverLetterPanel} from '@/components/coverletter/CoverLetterPanel';
      import {useSession} from 'next-auth/react';
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
      function LetterPanelProbe(){
        const [jobId,setJobId]=useState('outside-page'); const [selected,setSelected]=useState<string|null>('selected-letter'); const [shown,setShown]=useState(true);
        return <><button onClick={()=>setJobId(v=>v==='outside-page'?'other-job':'outside-page')}>Switch panel job</button><button onClick={()=>setSelected('other-selected')}>Switch selected letter</button><button onClick={()=>setSelected(null)}>Clear selected letter</button><button onClick={()=>setShown(v=>!v)}>Toggle panel</button>{shown && <CoverLetterPanel job={{id:jobId,userId:'fixture-user',role:'Fixture role',company:'Fixture Employer',finalCoverLetterId:selected}} resumeContent={{contact:{name:'Fixture'}}} resumeName="Fixture" templateId="clean" templateOptions={{}} onClose={()=>{globalThis.__fixturePanelCloseCalls=(globalThis.__fixturePanelCloseCalls||0)+1}} />}</>
      }
      function MultiLetterPanelProbe(){
        const [first,setFirst]=useState(true);const job={id:'outside-page',userId:'fixture-user',role:'Fixture role',company:'Fixture Employer',finalCoverLetterId:'selected-letter'};
        const panel=()=> <CoverLetterPanel job={job} resumeContent={{contact:{name:'Fixture'}}} resumeName="Fixture" templateId="clean" templateOptions={{}} onClose={()=>{}}/>;
        return <><button onClick={()=>setFirst(false)}>Hide first letter panel</button>{first&&<div data-testid="first-letter-panel">{panel()}</div>}<div data-testid="second-letter-panel">{panel()}</div></>
      }
      function OwnerLetterPanelProbe(){
        const {data}=useSession(); const [shown,setShown]=useState(true); const owner=data?.user?.id||'fixture-user';
        const job={id:owner==='fixture-b'?'other-job':'outside-page',userId:owner,role:owner==='fixture-b'?'Fixture B Role':'Fixture A Role',company:'Fixture Employer',finalCoverLetterId:'selected-letter'};
        return <><button onClick={()=>setShown(v=>!v)}>Toggle owner panel</button>{shown&&<CoverLetterPanel job={job} resumeContent={{contact:{name:'Fixture'}}} resumeName="Fixture" templateId="clean" templateOptions={{}} onClose={()=>{}}/>}</>
      }
      function Harness(){
        const [page,setPage]=useState(new URL(location.href).searchParams.get('page')||'jobs');
        const navigate=(next)=>{if(globalThis.__fixtureBlockNavigation)return false;const url=new URL(location.href);url.searchParams.set('page',next);history.pushState({},'',url);setPage(next)};
        useEffect(()=>{const restore=()=>setPage(new URL(location.href).searchParams.get('page')||'jobs');addEventListener('popstate',restore);return()=>removeEventListener('popstate',restore)},[]);
        return <I18nProvider><ToastProvider><NavContext.Provider value={{navigate}}>
          <nav aria-label="Fixture navigation">{['jobs','resume','search','dashboard'].map(name=><button key={name} onClick={()=>navigate(name)}>Fixture {name}</button>)}</nav>
          <main style={{display:'flex',height:'calc(100vh - 32px)',minWidth:0}}>
          {page==='jobs'?<JobsPage/>:page==='resume'?<ResumePage/>:page==='search'?<SearchPage/>:page==='dashboard'?<DashboardPage/>:page==='letter-probe'?<LetterProbe/>:page==='letter-panel-probe'?<LetterPanelProbe/>:page==='multi-letter-panel-probe'?<MultiLetterPanelProbe/>:page==='owner-letter-panel-probe'?<OwnerLetterPanelProbe/>:<AgentDestination/>}
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
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{"NODE_ENV":"production"}' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent',
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
  // include Chromium's blocked ports (e.g. 6669) or reserved TCP ranges.
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
      if (!(error instanceof Error) || !('code' in error)
        || (error.code !== 'EADDRINUSE' && !(process.platform === 'win32' && error.code === 'EACCES'))) throw error
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
const fixtureAuditOperation = '123e4567-e89b-42d3-a456-426614174000'
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
function audit(resumeUpdatedAt = time, hasCoverLetter = false) {
  const findings = [{ area: 'resume', severity: 'pass', title: 'Verified', evidence: 'Supported', action: 'None' }]
  if (hasCoverLetter) findings.push({ area: 'cover_letter', severity: 'pass', title: 'Verified', evidence: 'Supported', action: 'None' })
  const record = { resumeId: 'resume-1', coverLetterId: null, resumeUpdatedAt, operationId: fixtureAuditOperation, receipt: { version: 1 as const, signature: 'a'.repeat(64) },
    audit: { verdict: 'pass', summary: 'Fixture materials checked.', findings, matchScore: 82, source: 'independent', auditedAt: time } }
  return record as typeof record & { coverLetterUpdatedAt?: string }
}

async function install(page: Page, options: { stale?: boolean; taskCheckpoint?: string | null; taskStatus?: 'unknown' | 'waiting_for_user' | 'waiting_for_authorization' | 'cancelled' | 'failed' | 'filling'; recordedInitially?: boolean; evidenceCase?: 'bound' | 'unbound' | 'unavailable'; previewMismatch?: 'owner' | 'id' | 'job'; malformedPreview?: 'content' | 'contact'; letterRaceProbe?: boolean; letterInvalid?: 'null' | 'owner' | 'job' | 'duplicate' | 'content'; letterAfterInitial?: 'changed' | 'failure' | 'hold' | 'manual-change' | 'audit-same' | 'audit-failure' | 'audit-hold'; auditVersion?: 'same' | 'resume-changed' | 'letter-changed' | 'resume-missing' | 'letter-missing'; holdAudit?: boolean; holdAssign?: boolean; externalLetterSelection?: boolean; failTailoredRead?: boolean; taskFailure?: boolean; taskLimited?: boolean; missing?: boolean; holdSelectedLetter?: boolean; selectedLetter?: boolean; firstPreparation?: boolean; descriptionMode?: 'success' | 'unknown' | 'audit' | 'two' | 'conflict' | 'hold-response' | 'hold-other'; initialDescription?: string | null; holdBaseSave?: boolean; failBaseSave?: boolean; baseList?: 'empty' | 'fail-once' | 'fail-once-hold' | 'hold-empty' | 'multiple' | 'single' | 'default'; failFirstAudit?: boolean; flowSave?: boolean; manualOutcome?: 'get-fails' | 'unknown'; search?: boolean; saveMode?: 'fail' | 'hold-success' | 'hold-fail'; twoResumes?: boolean; holdResumeContent?: boolean; snapshotResumeContent?: boolean; resumeRevalidationFails?: boolean; versionedScore?: boolean; holdOldAnalysis?: boolean; holdFirstAnalysisOnly?: boolean; auditCorrection?: boolean; holdAuditCorrection?: boolean; versions?: boolean; holdVersionRestore?: boolean; versionRestoreFails?: boolean; realAgent?: boolean; expiredApproval?: boolean; twoJobQuestions?: boolean; delayedQuestionTask?: boolean; holdFirstTaskRead?: boolean; holdReturnOwnerA?: boolean; taskPerUser?: boolean; dashboardFourTasks?: boolean; agentJourney?: boolean } = {}) {
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
  const state = { job: { ...job(), description: job().description as string | null, followUpAt: null as string | null, appliedAt: null as string | null, finalCoverLetterId: options.holdSelectedLetter || options.selectedLetter ? 'selected-letter' : null, finalResumeId: options.firstPreparation ? null : 'resume-1' }, resume: resume(), audit: options.auditCorrection ? { ...audit(), audit: { ...audit().audit, verdict: 'needs_review', findings: [{ area: 'resume', target: 'summary', severity: 'warning', title: 'Fix summary', evidence: 'Outdated wording', action: 'Apply correction', proposedValue: 'Audited v2 summary' }] } } : audit(options.stale ? '2026-10-29T10:00:00.000Z' : time),
    secondResume: { ...resume(), id: 'resume-2', name: 'Second fixture resume', targetJobId: null as string | null, content: { ...resume().content, summary: 'Second resume content.' } },
    answeredJobA: false, saveResponses: 0, packRequests: 0, armReturnOwnerA: false, returnOwnerAEntered: false, releaseReturnOwnerA, manualPosted: false, manualReadAvailable: false, hideResumeOnExport: false, malformedPreview: options.malformedPreview ?? null, selectedLetterAvailable: false, failNextDescriptionAudit: false, descriptionWriteStarted: false, otherJobUpdateStarted: false, releaseDescription, releaseOtherJobUpdate, savedBase: null as (Omit<ReturnType<typeof resume>, 'targetJobId'> & { targetJobId: string | null }) | null, baseSaveStarted: false, releaseBaseSave, baseListReads: 0, releaseBaseList, invalidLetter: options.letterInvalid ?? null, probeLetterReads: 0, selectedLetterReads: 0, changeLetterOnRead: false, auditStarted: false, assignStarted: false, releaseAudit, releaseAssign, releaseProbeLetter, fontRequests: [] as string[], activeUserId: 'fixture-user', agentStage: 'question' as 'question' | 'approval' | 'running' | 'unknown', requestOwners: [] as Array<{ path: string; method: string; userId: string }>, agentRequests: [] as Array<{ path: string; method: string; body?: unknown }>, writes: [] as Array<{ path: string; body: unknown }>, analysisRequests: [] as string[], analysisBodies: [] as unknown[], analysisCalls: [] as Array<{ path: string; body: unknown }>, unexpected: [] as string[], taskReads: 0, staleJobRequested: false, staleJobReturned: false, releaseStaleJob, taskStatusOverride: null as 'waiting_for_authorization' | null, firstTaskReadFinished: false, releaseFirstTaskRead, letterRequested: false, resumeContentRequested: false, releaseLetters, releaseSave, releaseResumeContent, releaseOldAnalysis, releaseAuditCorrection, releaseVersionRestore }
  if (options.descriptionMode) state.job.description = options.initialDescription === undefined ? '' : options.initialDescription
  if (options.evidenceCase === 'unbound') state.job.finalResumeId = null
  if (options.previewMismatch === 'job') state.job.finalResumeId = null
  if (options.evidenceCase === 'unavailable') state.hideResumeOnExport = true
  if (options.failTailoredRead) state.hideResumeOnExport = true
  if (options.recordedInitially) state.job = { ...state.job, status: 'applied', workflowState: 'submitted' }
  if (options.selectedLetter) state.audit = { ...audit(options.stale ? '2026-10-29T10:00:00.000Z' : time, true), coverLetterId: 'selected-letter', coverLetterUpdatedAt: time }
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
          const question = { schemaVersion: 'agent-harness.v2', id: `item-${questionId}`, sessionId: id, turnId, stepId: null, taskId: null, type: 'question', status: answered ? 'completed' : 'started', phase: 'commentary', revision: answered ? 1 : 0, startedAt: null, completedAt: answered ? time : null, createdAt: time, updatedAt: time, sequence: '1', content: { waitKind: 'question', questionId, stage: 'profile', question: 'Confirm the same fixture fact?', options: [{ value: 'yes', label: 'Yes' }], answerAvailable: answered, pending: !answered } }
          return json(route, { items: [question], approvalEvents: [] })
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
    // Synthetic response only: real ZIP generation and audit signatures are covered by isolated route tests.
    if (request.method() === 'POST' && pathname.endsWith('/application-pack')) {
      state.packRequests++
      return route.fulfill({ status: 200, contentType: 'application/zip', headers: { 'Content-Disposition': "attachment; filename*=UTF-8''fixture-pack.zip" }, body: 'synthetic server ZIP response' })
    }
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
        const nextOperation = '123e4567-e89b-42d3-a456-426614174001'
        state.resume = { ...state.resume, updatedAt, content: { ...state.resume.content, summary: 'Audited v2 summary' } }
        state.audit = { ...state.audit, operationId: nextOperation, resumeUpdatedAt: updatedAt, receipt: { version: 1, signature: 'b'.repeat(64) }, audit: { ...state.audit.audit, verdict: 'needs_review', summary: 'A generated correction was applied. Run the independent audit again before final confirmation.', auditedAt: updatedAt, findings: state.audit.audit.findings.map(finding => ({ ...finding, applied: true, appliedAt: updatedAt })) } }
        return json(route, { audit: state.audit.audit, operationId: nextOperation, target: 'summary', appliedContent: 'Audited v2 summary', resume: state.resume, coverLetter: null, resumeUpdatedAt: updatedAt })
      }
      if (pathname.endsWith('/tailor-resume')) return json(route, { adaptedResumeId: 'resume-1' })
      if (pathname === '/api/resume' && options.baseList === 'empty') { state.baseSaveStarted = true; if (options.holdBaseSave) await baseSaveGate; if (options.failBaseSave) return route.abort('failed'); const saved = body as { name: string; content: ReturnType<typeof resume>['content'] }; state.savedBase = { ...state.resume, id: 'base-created', kind: 'base', targetJobId: null, name: saved.name, content: saved.content }; return json(route, state.savedBase) }
      if (pathname.endsWith('/audit-application')) { state.auditStarted = true; if (options.holdAudit) await auditGate; if (options.failFirstAudit && state.writes.filter(write => write.path.endsWith('/audit-application')).length === 1) return json(route, { error: 'Fixture audit unavailable' }, 500); const letterId = (body as { coverLetterId?: string | null }).coverLetterId ?? null; state.audit = { ...audit(state.resume.updatedAt, Boolean(letterId)), coverLetterId: letterId, ...(letterId ? { coverLetterUpdatedAt: time } : {}) }; return json(route, { ...state.audit.audit, operationId: state.audit.operationId, ...(options.auditVersion === 'resume-missing' ? {} : { resumeUpdatedAt: options.auditVersion === 'resume-changed' ? '2026-10-30T11:00:00.000Z' : state.resume.updatedAt }), ...(letterId && options.auditVersion !== 'letter-missing' ? { coverLetterUpdatedAt: options.auditVersion === 'letter-changed' ? '2026-10-30T11:00:00.000Z' : time } : {}) }) }
      if (pathname.endsWith('/assign')) { state.assignStarted = true; if (options.holdAssign) await assignGate; Object.assign(state.job, body); return json(route, state.job) }
      if (pathname === '/api/jobs/outside-page/apply') { state.manualPosted = true; if (options.manualOutcome === 'unknown') return route.abort('failed'); Object.assign(state.job, { status: 'applied', workflowState: 'submitted', appliedAt: time }); return json(route, { applied: true }) }
      return json(route, { error: 'Unexpected mutation' }, 500)
    }
    if (options.search && pathname === '/api/search/unified') return json(route, { jobs: [{ id: 'search-result-1', title: state.job.role, company: state.job.company, location: state.job.location, url: state.job.url, description: '', source: 'manual', score: 82 }], meta: null })
    if (pathname === '/api/agent/application-tasks') {
      state.taskReads++
      if (options.taskFailure) return json(route, { error: 'Fixture unavailable' }, 500)
      if (options.taskLimited) return json(route, { tasks: Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, userId: 'fixture-user', jobId: `other-job-${i}`, sessionId: `session-${i}`, status: 'filling', checkpoint: null, updatedAt: time, job: { company: 'Other employer', role: 'Other role' } })) })
      if (options.twoJobQuestions) return json(route, { tasks: [{ id: 'task-a', userId: 'fixture-user', jobId: 'outside-page', sessionId: 'session-a', status: state.answeredJobA && !options.delayedQuestionTask ? 'filling' : 'waiting_for_user', checkpoint: state.answeredJobA && !options.delayedQuestionTask ? null : 'form_answer_required', updatedAt: time, job: { company: 'Fixture Employer', role: 'Application flow engineer' } }, { id: 'task-b', userId: 'fixture-user', jobId: 'job-2', sessionId: 'session-b', status: 'waiting_for_user', checkpoint: 'form_answer_required', updatedAt: time, job: { company: 'Employer B', role: 'Role B' } }] })
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
        checkpoint: currentTaskStatus === 'unknown' ? 'submission_uncertain' : currentTaskStatus === 'waiting_for_user' ? (options.taskCheckpoint === undefined ? 'form_answer_required' : options.taskCheckpoint) : currentTaskStatus === 'cancelled' || currentTaskStatus === 'failed' ? 'turn_stopped_before_submit' : null, updatedAt: time, job: { company: state.job.company, role: state.job.role } }] : [] })
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

for (const condition of ['saved', 'recorded', 'unavailable', 'limited'] as const) {
  test(`application list explains ${condition} and opens the same job`, async ({ page }, testInfo) => {
    const state = await install(page, { descriptionMode: 'two', recordedInitially: condition === 'recorded',
      taskFailure: condition === 'unavailable', taskLimited: condition === 'limited' })
    await page.goto(`${origin}/?page=jobs`)
    const mobile = testInfo.project.name.startsWith('mobile')
    const entry = mobile ? page.locator('.jobs-mobile-list article').filter({ hasText: 'Application flow engineer' })
      : page.getByRole('row').filter({ hasText: 'Application flow engineer' })
    const expected = condition === 'saved' ? /Saved for review.*next step|职位已保存.*下一步/
      : condition === 'recorded' ? /submission record exists.*history|已有提交记录.*查看历史/
        : condition === 'unavailable' ? /Task status is unavailable.*existing records|无法读取任务状态.*核对现有记录/
          : /Task coverage is limited.*check its status|任务覆盖范围有限.*检查状态/
    await expect(entry).toContainText(expected)
    await expect(entry).not.toContainText(/audit passed|审核已通过|no related task|没有相关任务/i)
    const action = entry.getByRole('button', { name: /View this application|查看此申请/ })
    if (mobile) await expect(action).toHaveAccessibleDescription(expected)
    await action.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/highlight=outside-page/)
    await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

for (const status of ['applied', 'interview', 'offer', 'rejected'] as const) {
  for (const coverage of ['ready', 'limited', 'unavailable'] as const) {
    test(`application list treats ${status} with ${coverage} task coverage honestly`, async ({ page }, testInfo) => {
      const state = await install(page, { descriptionMode: 'two', taskFailure: coverage === 'unavailable', taskLimited: coverage === 'limited' })
      state.job.status = status
      await page.goto(`${origin}/?page=jobs`)
      const mobile = testInfo.project.name.startsWith('mobile')
      const entry = mobile ? page.locator('.jobs-mobile-list article').filter({ hasText: 'Application flow engineer' })
        : page.getByRole('row').filter({ hasText: 'Application flow engineer' })
      const expected = coverage === 'unavailable' ? /Task status is unavailable.*existing records|无法读取任务状态.*核对现有记录/
        : coverage === 'limited' ? /Task coverage is limited.*check its status|任务覆盖范围有限.*检查状态/
          : status === 'applied' ? /submission record exists.*history|已有提交记录.*查看历史/
            : /Check the application status and history|检查申请状态和历史/
      await expect(entry).toContainText(expected)
      await expect(entry).not.toContainText(/audit passed|审核已通过|no related task|没有相关任务/i)
      const action = entry.getByRole('button', { name: /View this application|查看此申请/ })
      if (mobile) await expect(action).toHaveAccessibleDescription(expected)
      await action.focus()
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL(/highlight=outside-page/)
      await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
      expect(state.writes).toEqual([])
      expect(state.unexpected).toEqual([])
    })
  }
}

test('application list shows loading and then the existing task without duplicating its action', async ({ page }, testInfo) => {
  const state = await install(page, { descriptionMode: 'two', taskStatus: 'waiting_for_user', holdFirstTaskRead: true })
  try {
    await page.goto(`${origin}/?page=jobs`)
    const entry = testInfo.project.name.startsWith('mobile') ? page.locator('.jobs-mobile-list article').filter({ hasText: 'Application flow engineer' })
      : page.getByRole('row').filter({ hasText: 'Application flow engineer' })
    await expect(entry).toContainText(/Checking related task status|正在检查相关任务状态/)
    expect(state.taskReads).toBe(1)
    state.releaseFirstTaskRead()
    await expect(entry).toContainText(/Your action is needed|需要你处理/)
    await expect(entry.getByRole('button', { name: /Continue in the original task|进入原任务处理/ })).toHaveCount(1)
    await expect(entry).not.toContainText(/Saved for review.*next step|职位已保存.*下一步/)
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { state.releaseFirstTaskRead() }
})

// Model the browser's confirmed POST receipt independently of the helper under
// test: an exact digest is required before a stale proof can permit recovery.
function fixtureConfirmedFence(record: ReturnType<typeof audit>) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]))
    return value
  }
  const a = record.audit
  const digest = createHash('sha256').update(JSON.stringify(canonical([a.verdict, a.auditedAt, a.summary, a.matchScore, a.source, a.findings]))).digest('hex')
  return { version: 1, state: 'confirmed', attemptId: '123e4567-e89b-42d3-a456-426614174001', resumeId: record.resumeId,
    coverLetterId: record.coverLetterId, operationId: record.operationId, resumeUpdatedAt: record.resumeUpdatedAt,
    coverLetterUpdatedAt: record.coverLetterUpdatedAt ?? null, digest }
}

test.beforeEach(async ({ page }, testInfo) => {
  page.on('pageerror', error => console.error('Mounted fixture browser error:', error.message))
  await page.addInitScript(locale => localStorage.setItem('applymate_lang', locale), testInfo.project.metadata.appLocale === 'zh' ? 'zh' : 'en')
})

for (const surface of ['jobs', 'resume'] as const) {
  test(`${surface} only retries a confirmed stale review after explicit user action`, async ({ page }, testInfo) => {
    test.skip(!['desktop-en', 'mobile-zh'].includes(testInfo.project.name), 'Checks English desktop and Chinese mobile')
    const state = await install(page)
    const completedProof = structuredClone(state.audit)
    const fence = fixtureConfirmedFence(completedProof)
    const fenceKey = 'applymate:audit-fence:fixture-user:outside-page'
    state.resume = { ...state.resume, updatedAt: '2026-10-30T12:10:00.000Z' }
    await page.addInitScript(({ fenceKey, fence }) => {
      if (!sessionStorage.getItem(fenceKey)) sessionStorage.setItem(fenceKey, JSON.stringify(fence))
    }, { fenceKey, fence })
    const posts: Array<{ expected?: string; attempt?: string }> = []
    await page.route('**/api/jobs/outside-page/audit-application', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { state: 'stale', completedProof } })
      const headers = route.request().headers()
      posts.push({ expected: headers['x-expected-audit-operation-id'], attempt: headers['x-application-audit-attempt-id'] })
      return route.fulfill({ status: 409, json: { code: 'AUDIT_PREDECESSOR_CHANGED', error: 'The predecessor review changed.' } })
    })
    if (surface === 'jobs') await open(page)
    else await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    const marker = () => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), fenceKey)
    await expect.poll(async () => (await marker())?.state).toBe('retryable')
    expect(await marker()).toMatchObject({ state: 'retryable', operationId: fixtureAuditOperation, digest: fence.digest })
    expect(posts).toEqual([])
    await page.reload()
    await expect.poll(async () => (await marker())?.state).toBe('retryable')
    if (surface === 'jobs') await page.getByRole('dialog').getByRole('button', { name: /Close application details|关闭申请详情/ }).click()
    await page.getByRole('button', { name: surface === 'jobs' ? 'Fixture resume' : 'Fixture jobs' }).click()
    await page.getByRole('button', { name: surface === 'jobs' ? 'Fixture jobs' : 'Fixture resume' }).click()
    if (surface === 'jobs') await open(page)
    await expect.poll(async () => (await marker())?.state).toBe('retryable')
    expect(posts).toEqual([])
    const trigger = surface === 'jobs' ? page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
      : page.getByRole('button', { name: /Run independent audit|Run audit again|运行独立审核|再次运行审核/ })
    await expect(trigger).toBeEnabled()
    await trigger.click()
    await expect.poll(() => posts.length).toBe(1)
    expect(posts[0].expected).toBe(fixtureAuditOperation)
    expect(posts[0].attempt).toMatch(/^[0-9a-f-]{36}$/i)
    await expect.poll(async () => (await marker())?.state).toBe('pending')
    expect(await marker()).toMatchObject({ state: 'pending', expectedOperationId: fixtureAuditOperation, attemptId: posts[0].attempt })
    await page.reload()
    await expect.poll(async () => (await marker())?.state).toBe('pending')
    if (await trigger.isVisible() && await trigger.isEnabled()) await trigger.click()
    expect(posts).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  })

  for (const selection of ['changed-resume', 'added-letter', 'changed-letter', 'removed-letter'] as const) {
    test(`${surface} confirms ${selection} before retrying a completed stale review`, async ({ page }, testInfo) => {
      test.skip(!['desktop-en', 'mobile-zh'].includes(testInfo.project.name), 'Checks English desktop and Chinese mobile')
      const hasSelectedLetter = selection === 'added-letter' || selection === 'changed-letter'
      const state = await install(page, { twoResumes: selection === 'changed-resume', selectedLetter: hasSelectedLetter })
      const completedProof = selection === 'removed-letter' || selection === 'changed-letter'
        ? { ...audit(time, true), coverLetterId: selection === 'changed-letter' ? 'old-letter' : 'selected-letter', coverLetterUpdatedAt: time }
        : audit()
      const fence = fixtureConfirmedFence(completedProof)
      const fenceKey = 'applymate:audit-fence:fixture-user:outside-page'
      const selectedResume = selection === 'changed-resume' ? 'resume-2' : 'resume-1'
      const selectedLetter = hasSelectedLetter ? 'selected-letter' : null
      if (selection === 'changed-resume') {
        state.job.finalResumeId = 'resume-2'
        state.secondResume = { ...state.secondResume, targetJobId: 'outside-page' }
      }
      state.job.finalCoverLetterId = selectedLetter
      // The Resume page validates that the selected letter is bound to the
      // chosen resume (or explicitly unbound), just like the real API row.
      if (hasSelectedLetter) await page.route('**/api/jobs/outside-page/cover-letters', route => route.fulfill({ json: [{
        id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', resumeId: selectedResume,
        content: 'I am excited to contribute my TypeScript experience.', tone: 'professional', createdAt: time, updatedAt: time,
      }] }))
      await page.addInitScript(({ fenceKey, fence }) => {
        if (!sessionStorage.getItem(fenceKey)) sessionStorage.setItem(fenceKey, JSON.stringify(fence))
      }, { fenceKey, fence })
      const posts: Array<{ expected?: string; body: unknown }> = []
      await page.route('**/api/jobs/outside-page/audit-application', async route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: { state: 'stale', completedProof } })
        posts.push({ expected: route.request().headers()['x-expected-audit-operation-id'], body: route.request().postDataJSON() })
        return route.fulfill({ status: 409, json: { code: 'AUDIT_PREDECESSOR_CHANGED', error: 'The predecessor review changed.' } })
      })
      const dialogs: string[] = []
      let acceptSelection = false
      page.on('dialog', async dialog => {
        dialogs.push(dialog.message())
        if (acceptSelection) await dialog.accept()
        else await dialog.dismiss()
      })
      if (surface === 'jobs') await open(page)
      else await page.goto(`${origin}/?page=resume&resumeId=${selectedResume}&returnToJobs=1&returnJobId=outside-page`)
      const marker = () => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), fenceKey)
      await expect.poll(async () => (await marker())?.state).toBe('retryable')
      const trigger = surface === 'jobs' ? page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
        : page.getByRole('button', { name: /Run independent audit|Run audit again|运行独立审核|再次运行审核/ })
      await expect(trigger).toBeEnabled()
      await trigger.click()
      await expect.poll(() => dialogs.length).toBe(1)
      expect(dialogs[0]).toMatch(/The selected materials have changed since the previous review|所选材料与上次审核时不同/)
      expect(dialogs[0]).toContain(selection === 'changed-resume' ? 'Second fixture resume' : 'Fixture role resume')
      expect(dialogs[0]).toMatch(hasSelectedLetter ? /Selected|已选择/ : /Not selected|未选择/)
      expect(dialogs[0]).toMatch(/Check the material preview|请先查看材料预览/)
      if (hasSelectedLetter) expect(dialogs[0]).toContain('I am excited to contribute my TypeScript experience.')
      expect(dialogs[0]).toMatch(/does not submit an application|不会提交申请/)
      expect(posts).toEqual([])
      expect(await marker()).toMatchObject({ state: 'retryable', operationId: fixtureAuditOperation })
      acceptSelection = true
      await trigger.click()
      await expect.poll(() => posts.length).toBe(1)
      expect(dialogs).toHaveLength(2)
      expect(posts[0].expected).toBe(fixtureAuditOperation)
      const body = posts[0].body as { resumeId?: string; coverLetterId?: string | null }
      expect(body.resumeId).toBe(selectedResume)
      expect(body.coverLetterId ?? null).toBe(selectedLetter)
      await expect.poll(async () => (await marker())?.state).toBe('pending')
      expect(await marker()).toMatchObject({ state: 'pending', resumeId: selectedResume, coverLetterId: selectedLetter, expectedOperationId: fixtureAuditOperation })
      expect(state.writes.filter(write => write.path.endsWith('/tailor-resume'))).toEqual([])
      expect(state.unexpected).toEqual([])
    })
  }

  for (const mismatch of ['digest', 'operation', 'material-scope', 'no-proof', 'pending'] as const) {
    test(`${surface} refuses stale recovery for ${mismatch}`, async ({ page }, testInfo) => {
      test.skip(!['desktop-en', 'mobile-zh'].includes(testInfo.project.name), 'Checks English desktop and Chinese mobile')
      const state = await install(page)
      const completedProof = structuredClone(state.audit)
      const confirmed = fixtureConfirmedFence(completedProof)
      const marker = mismatch === 'pending'
        ? { version: 1, state: 'pending', attemptId: confirmed.attemptId, resumeId: confirmed.resumeId, coverLetterId: null }
        : mismatch === 'digest' ? { ...confirmed, digest: 'b'.repeat(64) } : confirmed
      if (mismatch === 'operation') completedProof.operationId = '123e4567-e89b-42d3-a456-426614174099'
      if (mismatch === 'material-scope') completedProof.resumeId = 'other-resume'
      const fenceKey = 'applymate:audit-fence:fixture-user:outside-page'
      await page.addInitScript(({ fenceKey, marker }) => {
        if (!sessionStorage.getItem(fenceKey)) sessionStorage.setItem(fenceKey, JSON.stringify(marker))
      }, { fenceKey, marker })
      let gets = 0, posts = 0
      await page.route('**/api/jobs/outside-page/audit-application', route => {
        if (route.request().method() !== 'GET') { posts++; return route.fallback() }
        gets++
        return route.fulfill({ json: mismatch === 'no-proof' ? { state: 'stale' } : { state: 'stale', completedProof } })
      })
      if (surface === 'jobs') await open(page)
      else await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
      const pending = page.getByText(/This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i).first()
      await expect(pending).toBeVisible()
      if (mismatch !== 'pending') await expect.poll(() => gets).toBeGreaterThan(0)
      await expect.poll(() => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), fenceKey)).toEqual(marker)
      await page.reload()
      await expect(pending).toBeVisible()
      expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), fenceKey)).toEqual(marker)
      expect(posts).toBe(0)
      expect(state.unexpected).toEqual([])
    })
  }

  test(`${surface} does not consume another job's confirmed review fence`, async ({ page }, testInfo) => {
    test.skip(!['desktop-en', 'mobile-zh'].includes(testInfo.project.name), 'Checks English desktop and Chinese mobile')
    const state = await install(page)
    const completedProof = structuredClone(state.audit)
    const fence = fixtureConfirmedFence(completedProof)
    const foreignKey = 'applymate:audit-fence:fixture-user:other-job'
    const currentKey = 'applymate:audit-fence:fixture-user:outside-page'
    await page.addInitScript(({ foreignKey, fence }) => sessionStorage.setItem(foreignKey, JSON.stringify(fence)), { foreignKey, fence })
    let gets = 0, posts = 0
    await page.route('**/api/jobs/outside-page/audit-application', route => {
      if (route.request().method() !== 'GET') { posts++; return route.fallback() }
      gets++
      return route.fulfill({ json: { state: 'stale', completedProof } })
    })
    if (surface === 'jobs') await open(page)
    else await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect.poll(() => gets).toBeGreaterThan(0)
    await expect(page.getByText(/The job or materials have changed, or this older review can no longer be verified|职位或材料已变化，或旧审核已无法核实/i).first()).toBeVisible()
    expect(await page.evaluate(key => sessionStorage.getItem(key), currentKey)).toBeNull()
    expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), foreignKey)).toEqual(fence)
    expect(posts).toBe(0)
    expect(state.unexpected).toEqual([])
  })
}

for (const scenario of [
  { reason: 'final_resume_too_long', en: 'The selected resume is too long to review in full. Shorten this version while keeping the facts accurate, then review it again.', zh: '所选简历内容过长，无法完整审核。请在保留真实事实的前提下精简此版本，然后重新审核。' },
  { reason: 'cover_letter_too_long', en: 'The selected cover letter is too long to review in full. Shorten it while keeping the facts accurate, then review it again.', zh: '所选求职信内容过长，无法完整审核。请在保留真实事实的前提下精简，然后重新审核。' },
  { reason: 'source_resume_too_long', en: 'The source resume is too long to review in full. Check whether other applications use it, then shorten it while keeping the facts accurate and review again.', zh: '作为依据的原始简历内容过长，无法完整审核。请先确认它是否用于其他申请，再在保留真实事实的前提下精简并重新审核。' },
  { reason: 'persona_too_long', en: 'The confirmed profile information is too long to review in full. Check for irrelevant or repeated details, retain accurate facts, then review again.', zh: '已确认的职业资料内容过长，无法完整审核。请检查无关或重复内容，保留真实事实后重新审核。' },
  { reason: 'invalid_content', en: 'The review content could not be read. Check the selected materials, then try the review again.', zh: '无法读取审核内容。请检查所选材料，然后重新审核。' },
] as const) for (const surface of ['jobs', 'resume'] as const) {
  test(`audit limit ${scenario.reason} gives ${surface} guidance without retry`, async ({ page }, testInfo) => {
    test.skip(!['desktop-en', 'mobile-zh'].includes(testInfo.project.name), 'Checks English desktop and Chinese mobile')
    const state = await install(page, { stale: true })
    let auditPosts = 0
    await page.route('**/api/jobs/outside-page/audit-application', async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      auditPosts++
      return route.fulfill({ status: 422, json: { error: AUDIT_LIMIT_MESSAGES[scenario.reason] } })
    })
    if (surface === 'jobs') {
      await open(page)
      await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
    } else {
      await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
      await expect(page.locator('.resume-opportunity-card')).toContainText('Application flow engineer')
      await page.getByRole('button', { name: /Run independent audit|Run audit again|运行独立审核|再次运行审核/ }).click()
    }
    const expected = testInfo.project.name === 'mobile-zh' ? scenario.zh : scenario.en
    await expect(page.getByText(expected, { exact: false }).first()).toBeVisible()
    if (surface === 'resume') await expect(page.locator('.resume-audit-card-error')).toContainText(expected)
    await expect(page).toHaveURL(/outside-page/)
    await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
    await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
    expect(auditPosts).toBe(1)
    expect(state.writes.filter(write => write.path.endsWith('/assign'))).toEqual([])
    expect(state.packRequests).toBe(0)
    expect(state.unexpected).toEqual([])
  })
}

for (const surface of ['jobs', 'resume'] as const) for (const proof of ['matching', 'wrong-attempt'] as const) {
  test(`${surface} only releases a certified pre-registration limit for its own attempt: ${proof}`, async ({ page }, testInfo) => {
    test.skip(!['desktop-en', 'mobile-zh'].includes(testInfo.project.name), 'Checks English desktop and Chinese mobile')
    const state = await install(page, { stale: true })
    let posts = 0
    await page.route('**/api/jobs/outside-page/audit-application', route => {
      if (route.request().method() !== 'POST') return route.fallback()
      posts++
      if (posts > 1) return route.fallback()
      const attempt = route.request().headers()['x-application-audit-attempt-id']
      return route.fulfill({ status: 422, json: { error: AUDIT_LIMIT_MESSAGES.final_resume_too_long, code: 'AUDIT_PRECHECK_NOT_REGISTERED', auditRegistration: 'not_started', auditAttemptId: proof === 'matching' ? attempt : '123e4567-e89b-42d3-a456-426614174099' } })
    })
    if (surface === 'jobs') await open(page)
    else await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    const trigger = surface === 'jobs' ? page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }) : page.getByRole('button', { name: /Run independent audit|Run audit again|运行独立审核|再次运行审核/ })
    await trigger.click()
    await expect.poll(() => posts).toBe(1)
    const message = testInfo.project.name === 'mobile-zh' ? /所选简历内容过长/ : /selected resume is too long/i
    await expect(page.getByText(message, { exact: false }).first()).toBeVisible()
    const marker = () => page.evaluate(() => sessionStorage.getItem('applymate:audit-fence:fixture-user:outside-page'))
    if (proof === 'matching') await expect.poll(marker).toBeNull()
    else await expect.poll(marker).not.toBeNull()
    expect(posts).toBe(1)
    if (proof === 'matching') {
      await expect(trigger).toBeEnabled()
      await trigger.click()
      await expect.poll(() => posts).toBe(2)
    } else {
      const status = page.getByRole('status').filter({ hasText: /unconfirmed review request|尚未确认的审核请求/ }).first()
      await expect(status).toBeVisible()
      if (surface === 'jobs') {
        await expect(trigger).toBeDisabled()
        const refresh = status.getByRole('button', { name: /Refresh status|刷新状态/, exact: true })
        await expect(refresh).toBeEnabled()
        await refresh.click()
        await expect(status).toBeVisible()
      } else await trigger.click()
      expect(posts).toBe(1)
    }
    expect(state.unexpected).toEqual([])
  })
}

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
  await page.route('**/api/jobs?*', route => changes.length ? route.fulfill({ json: { jobs: [state.job, { ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role', status: 'interview' }], total: 80, statusCounts: { saved: 79, applied: 0, interview: 1, offer: 0, rejected: 0 } } }) : route.fallback())
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

for (const mode of ['missing', 'error', 'misbound'] as const) test(`selected cover letter is never replaced by another draft when ${mode}`, async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop-'), 'Exercises desktop editor')
  const state = await install(page)
  let retried = false
  const other = { id: 'other-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Wrong draft', tone: 'professional', createdAt: time }
  const selected = { ...other, id: 'selected-letter', content: 'Selected letter' }
  await page.route('**/api/jobs/outside-page/cover-letters', route => {
    if (retried) return route.fulfill({ json: [other, selected] })
    if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    return route.fulfill({ json: mode === 'missing' ? [other] : [other, { ...selected, userId: 'fixture-b' }] })
  })
  await page.goto(`${origin}/?page=letter-panel-probe`)
  await expect(page.getByRole('alert')).toContainText(/selected cover letter could not be loaded|无法加载已选求职信/)
  await expect(page.locator('textarea')).toHaveCount(0)
  await expect(page.getByText('Wrong draft')).toHaveCount(0)
  retried = true
  await page.getByRole('button', { name: /Try again|重试/i }).click()
  await expect(page.locator('textarea')).toHaveValue('Selected letter')
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('late cover letter load cannot cross job or account scope', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop editor scope')
  const state = await install(page)
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let started = false
  await page.route('**/api/jobs/*/cover-letters', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    if (id === 'outside-page') { started = true; await gate }
    try { await route.fulfill({ json: [{ id: 'selected-letter', userId: 'fixture-user', jobId: id, content: id === 'outside-page' ? 'Old job letter' : 'New job letter', tone: 'professional', createdAt: time }] }) } catch { /* an old read may be cancelled */ }
  })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await expect.poll(() => started).toBe(true)
    await page.getByRole('button', { name: 'Switch panel job' }).dispatchEvent('click')
    await expect(page.locator('textarea')).toHaveValue('New job letter')
    release()
    await expect(page.locator('textarea')).toHaveValue('New job letter')
    await fixtureSession(page, 'authenticated', 'fixture-b')
    await expect(page.locator('textarea')).toHaveCount(0)
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('failed cover letter save prevents version switching and retains the editable draft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let writes = 0
  const row = { userId: 'fixture-user', jobId: 'outside-page', tone: 'professional', createdAt: time }
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.fulfill({ json: [{ ...row, id: 'selected-letter', content: 'Original' }, { ...row, id: 'other-letter', content: 'Other' }] }))
  await page.route('**/api/cover-letters/selected-letter', route => { writes++; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }) })
  await page.goto(`${origin}/?page=letter-panel-probe`)
  const editor = page.locator('textarea')
  await expect(editor).toHaveValue('Original')
  await editor.fill('Private unsaved edit')
  await page.locator('select').first().selectOption('other-letter')
  await expect(editor).toHaveValue('Private unsaved edit')
  await expect(page.locator('select').first()).toHaveValue('selected-letter')
  await expect.poll(() => writes).toBe(1)
  await page.waitForTimeout(1200)
  expect(writes).toBe(1)
  expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
  expect(state.unexpected).toEqual([])
})

test('cover letter draft survives switching job and account without cross-account display or retry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let writes = 0
  await page.route('**/api/jobs/*/cover-letters', route => { const id = new URL(route.request().url()).pathname.split('/')[3]; return route.fulfill({ json: [{ id: 'selected-letter', userId: 'fixture-user', jobId: id, content: id === 'other-job' ? 'Other job' : 'Original', tone: 'professional', createdAt: time }] }) })
  await page.route('**/api/cover-letters/*', route => { writes++; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }) })
  await page.goto(`${origin}/?page=letter-panel-probe`)
  const editor = page.locator('textarea')
  await expect(editor).toHaveValue('Original')
  await editor.fill('Private unsaved edit')
  await page.getByRole('button', { name: 'Switch panel job' }).dispatchEvent('click')
  await expect(editor).toHaveValue('Other job')
  await fixtureSession(page, 'authenticated', 'fixture-b')
  await expect(editor).toHaveCount(0)
  await fixtureSession(page, 'authenticated', 'fixture-user')
  await expect(editor).toHaveValue('Other job')
  await page.getByRole('button', { name: 'Switch panel job' }).dispatchEvent('click')
  await expect(editor).toHaveValue('Private unsaved edit')
  await page.waitForTimeout(1200)
  expect(writes).toBe(0)
  expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
  expect(state.unexpected).toEqual([])
})

test('a late failed letter save stays with its original account without retry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, writes = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const letter = { id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Original', tone: 'professional', createdAt: time }
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.fulfill({ json: [letter] }))
  await page.route('**/api/cover-letters/selected-letter', async route => { writes++; await gate; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }) })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    const editor = page.locator('textarea')
    await expect(editor).toHaveValue('Original')
    await editor.fill('Account A pending edit')
    await expect.poll(() => writes).toBe(1)
    await fixtureSession(page, 'authenticated', 'fixture-b')
    await expect(editor).toHaveCount(0)
    await expect(page.getByText('Account A pending edit')).toHaveCount(0)
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/cover-letters/selected-letter' && r.request().method() === 'PATCH')
    release()
    await response
    await expect(editor).toHaveCount(0)
    await fixtureSession(page, 'authenticated', 'fixture-user')
    await expect(editor).toHaveValue('Account A pending edit')
    await expect(page.getByText(/Your local edits were kept/)).toBeVisible()
    await page.waitForTimeout(1200)
    expect(writes).toBe(1)
    expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('a late successful letter save cannot discard a newer edit after switching jobs', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, writes = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const letter = { id: 'selected-letter', userId: 'fixture-user', tone: 'professional', createdAt: time }
  await page.route('**/api/jobs/*/cover-letters', route => { const jobId = new URL(route.request().url()).pathname.split('/')[3]; return route.fulfill({ json: [{ ...letter, jobId, content: jobId === 'outside-page' ? 'Original' : 'Other job letter' }] }) })
  await page.route('**/api/cover-letters/selected-letter', async route => { writes++; await gate; return route.fulfill({ json: { ...letter, jobId: 'outside-page', content: 'First saved edit' } }) })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    const editor = page.locator('textarea')
    await expect(editor).toHaveValue('Original')
    await editor.fill('First saved edit')
    await expect.poll(() => writes).toBe(1)
    await editor.fill('Newer local edit')
    await page.getByRole('button', { name: 'Switch panel job' }).dispatchEvent('click')
    await expect(editor).toHaveValue('Other job letter')
    await page.getByRole('button', { name: 'Switch panel job' }).dispatchEvent('click')
    await expect(editor).toHaveValue('Newer local edit')
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/cover-letters/selected-letter' && r.request().method() === 'PATCH')
    release()
    await response
    await expect(editor).toHaveValue('Newer local edit')
    await page.waitForTimeout(1200)
    expect(writes).toBe(1)
    expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('failed generated cover letter save is separate from the selected letter', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let patches = 0
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Unavailable' } }) : route.fulfill({ json: [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Original selected letter', tone: 'professional', createdAt: time }] }))
  await page.route('**/api/ai/cover-letter', route => route.fulfill({ json: { coverLetter: 'Generated unsaved text' } }))
  await page.route('**/api/cover-letters/*', route => { patches++; return route.fulfill({ status: 503 }) })
  await page.goto(`${origin}/?page=letter-panel-probe`)
  await expect(page.locator('textarea')).toHaveValue('Original selected letter')
  await page.getByRole('button', { name: 'Generate letter', exact: true }).click()
  const generated = page.getByRole('alert').locator('textarea')
  await expect(generated).toHaveValue('Generated unsaved text')
  await expect(generated).toHaveAttribute('readonly', '')
  expect(patches).toBe(0)
  expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
  expect(state.unexpected).toEqual([])
})

test('a first generated letter whose save fails remains visible, copyable and discardable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Unavailable' } }) : route.fulfill({ json: [] }))
  await page.route('**/api/ai/cover-letter', route => route.fulfill({ json: { coverLetter: 'First unsaved generated letter' } }))
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { copiedLetter: string }).copiedLetter = value } } }) })
  await page.goto(`${origin}/?page=letter-panel-probe`)
  await page.getByRole('button', { name: 'Clear selected letter' }).dispatchEvent('click')
  await page.getByRole('button', { name: 'Generate letter', exact: true }).click()
  const notice = page.getByRole('alert')
  await expect(notice.locator('textarea')).toHaveValue('First unsaved generated letter')
  await notice.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedLetter?: string }).copiedLetter)).toBe('First unsaved generated letter')
  await notice.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('No cover letters yet. Generate one tailored to this job.')).toBeVisible()
  expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(false)
  await page.getByRole('button', { name: '✕', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fixturePanelCloseCalls?: number }).__fixturePanelCloseCalls ?? 0)).toBe(1)
  expect(state.unexpected).toEqual([])
})

test('closing while letter generation is pending retains text without sending a create request', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, started = false, creates = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/jobs/outside-page/cover-letters', route => { if (route.request().method() === 'POST') { creates++; return route.fulfill({ json: {} }) }; return route.fulfill({ json: [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Original', tone: 'professional', createdAt: time }] }) })
  await page.route('**/api/ai/cover-letter', async route => { started = true; await gate; return route.fulfill({ json: { coverLetter: 'Generated after close' } }) })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await expect(page.locator('textarea')).toHaveValue('Original')
    await page.getByRole('button', { name: 'Generate letter', exact: true }).click()
    await expect.poll(() => started).toBe(true)
    await page.clock.install()
    await page.getByRole('button', { name: '✕', exact: true }).click()
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/ai/cover-letter')
    release()
    await response
    await expect.poll(() => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
    await page.clock.fastForward(250)
    expect(creates).toBe(0)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('a lost create response survives remount without duplicate letter generation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, creates = 0, modelCalls = 0, created = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/jobs/outside-page/cover-letters', async route => {
    if (route.request().method() === 'POST') { creates++; created = true; await gate; return route.abort('failed') }
    return route.fulfill({ json: created ? [{ id: 'created-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Created but response lost', tone: 'professional', createdAt: time }] : [] })
  })
  await page.route('**/api/ai/cover-letter', route => { modelCalls++; return route.fulfill({ json: { coverLetter: 'Created but response lost' } }) })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await page.getByRole('button', { name: 'Clear selected letter' }).dispatchEvent('click')
    await page.getByRole('button', { name: 'Generate letter', exact: true }).click()
    await expect.poll(() => creates).toBe(1)
    await page.getByRole('button', { name: 'Toggle panel' }).dispatchEvent('click')
    await page.getByRole('button', { name: 'Toggle panel' }).dispatchEvent('click')
    await expect(page.getByRole('button', { name: /Generat/i }).first()).toBeDisabled()
    release()
    await expect(page.getByRole('alert').locator('textarea')).toHaveValue('Created but response lost')
    expect(creates).toBe(1)
    expect(modelCalls).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('a letter created after a remounted panel reads is displayed without a second create', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, creates = 0, reads = 0, created = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const saved = { id: 'created-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Created after remount', tone: 'professional', createdAt: time }
  await page.route('**/api/jobs/outside-page/cover-letters', async route => {
    if (route.request().method() === 'POST') { creates++; await gate; created = true; return route.fulfill({ json: saved }) }
    reads++
    return route.fulfill({ json: created ? [saved] : [] })
  })
  await page.route('**/api/ai/cover-letter', route => route.fulfill({ json: { coverLetter: 'Created after remount' } }))
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await page.getByRole('button', { name: 'Clear selected letter' }).dispatchEvent('click')
    await page.getByRole('button', { name: 'Generate letter', exact: true }).click()
    await expect.poll(() => creates).toBe(1)
    const oldReads = reads
    await page.getByRole('button', { name: 'Toggle panel' }).dispatchEvent('click')
    await page.getByRole('button', { name: 'Toggle panel' }).dispatchEvent('click')
    await expect.poll(() => reads).toBeGreaterThan(oldReads)
    await expect(page.getByRole('button', { name: /Generat/i }).first()).toBeDisabled()
    release()
    await expect(page.locator('textarea')).toHaveValue('Created after remount')
    expect(creates).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

for (const removeEdited of [false, true]) test(`background letter refresh ${removeEdited ? 'retains a missing draft for copying' : 'preserves the edited version'}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, creates = 0, created = false, completedRefreshes = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const row = { userId: 'fixture-user', jobId: 'outside-page', tone: 'professional', createdAt: time }
  const original = { ...row, id: 'selected-letter', content: 'Selected A' }
  const other = { ...row, id: 'other-letter', content: 'Other B' }
  const added = { ...row, id: 'new-letter', content: 'Generated letter' }
  await page.route('**/api/jobs/outside-page/cover-letters', async route => {
    if (route.request().method() === 'POST') { creates++; await gate; created = true; return route.fulfill({ json: added }) }
    const afterCreate = created
    await route.fulfill({ json: afterCreate ? [original, ...(removeEdited ? [] : [{ ...other, tone: 'concise' }]), added] : [original, other] })
    if (afterCreate) completedRefreshes++
  })
  await page.route('**/api/ai/cover-letter', route => route.fulfill({ json: { coverLetter: 'Generated letter' } }))
  try {
    await page.goto(`${origin}/?page=multi-letter-panel-probe`)
    const first = page.getByTestId('first-letter-panel')
    const second = page.getByTestId('second-letter-panel')
    await expect(first.locator('textarea')).toHaveValue('Selected A')
    await expect(second.locator('textarea')).toHaveValue('Selected A')
    await page.clock.install()
    await second.locator('select').first().selectOption('other-letter')
    await second.locator('textarea').fill('Unsaved B draft')
    await first.getByRole('button', { name: 'Generate letter', exact: true }).dispatchEvent('click')
    await expect.poll(() => creates).toBe(1)
    await page.getByRole('button', { name: 'Hide first letter panel' }).dispatchEvent('click')
    release()
    await expect.poll(() => completedRefreshes).toBeGreaterThan(0)
    if (removeEdited) {
      await expect(second.getByRole('alert').locator('textarea')).toHaveValue('Unsaved B draft')
      await expect(second.getByRole('alert').locator('textarea')).toHaveAttribute('readonly', '')
    } else {
      await expect(second.locator('textarea')).toHaveValue('Unsaved B draft')
      await expect(second.locator('select').first()).toHaveValue('other-letter')
      await expect(second.locator('select').first().locator('option[value="other-letter"]')).toContainText('concise')
    }
    expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
    expect(creates).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('unavailable selected letter still offers the same-job generated text for copying', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, creates = 0, unavailable = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/jobs/outside-page/cover-letters', async route => {
    if (route.request().method() === 'POST') { creates++; await gate; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }) }
    return route.fulfill({ json: unavailable ? [] : [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Selected A', tone: 'professional', createdAt: time }] })
  })
  await page.route('**/api/ai/cover-letter', route => route.fulfill({ json: { coverLetter: 'Recover generated text' } }))
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await expect(page.locator('textarea')).toHaveValue('Selected A')
    await page.getByRole('button', { name: 'Generate letter', exact: true }).click()
    await expect.poll(() => creates).toBe(1)
    await page.getByRole('button', { name: 'Toggle panel' }).dispatchEvent('click')
    unavailable = true
    release()
    await page.getByRole('button', { name: 'Toggle panel' }).dispatchEvent('click')
    const notice = page.getByRole('alert')
    await expect(notice).toContainText('selected cover letter could not be loaded')
    await expect(notice.locator('textarea')).toHaveValue('Recover generated text')
    await expect(notice.getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
    expect(creates).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('an unavailable generated draft never flashes across an account and job switch', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises account isolation in the letter editor')
  const state = await install(page)
  let release = () => {}, missingA = false, startedB = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/jobs/*/cover-letters', async route => {
    const jobId = new URL(route.request().url()).pathname.split('/')[3]
    if (route.request().method() === 'POST') return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    if (jobId === 'other-job') { startedB = true; await gate; return route.fulfill({ json: [{ id: 'selected-letter', userId: 'fixture-b', jobId, content: 'Account B letter', tone: 'professional', createdAt: time }] }) }
    return route.fulfill({ json: missingA ? [] : [{ id: 'selected-letter', userId: 'fixture-user', jobId, content: 'Account A letter', tone: 'professional', createdAt: time }] })
  })
  await page.route('**/api/ai/cover-letter', route => route.fulfill({ json: { coverLetter: 'Private generated A text' } }))
  try {
    await page.goto(`${origin}/?page=owner-letter-panel-probe`)
    await expect(page.locator('textarea')).toHaveValue('Account A letter')
    await page.getByRole('button', { name: 'Generate letter', exact: true }).click()
    await expect(page.getByRole('alert').locator('textarea')).toHaveValue('Private generated A text')
    missingA = true
    await page.getByRole('button', { name: 'Toggle owner panel' }).dispatchEvent('click')
    await page.getByRole('button', { name: 'Toggle owner panel' }).dispatchEvent('click')
    await expect(page.getByRole('alert').locator('textarea')).toHaveValue('Private generated A text')
    await page.evaluate(() => {
      const target = window as unknown as { fixtureCrossAccountLeak: boolean; fixtureLeakObserver: MutationObserver }
      target.fixtureCrossAccountLeak = false
      target.fixtureLeakObserver = new MutationObserver(() => {
        if (document.body.textContent?.includes('Fixture B Role') && [...document.querySelectorAll('textarea')].some(element => element.value.includes('Private generated A text'))) target.fixtureCrossAccountLeak = true
      })
      target.fixtureLeakObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    state.activeUserId = 'fixture-b'
    await fixtureSession(page, 'authenticated', 'fixture-b')
    await expect.poll(() => startedB).toBe(true)
    await expect(page.getByText('Fixture B Role')).toBeVisible()
    await expect(page.locator('textarea')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { fixtureCrossAccountLeak: boolean }).fixtureCrossAccountLeak)).toBe(false)
    release()
    await expect(page.locator('textarea')).toHaveValue('Account B letter')
    expect(await page.evaluate(() => (window as unknown as { fixtureCrossAccountLeak: boolean }).fixtureCrossAccountLeak)).toBe(false)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('completion of another letter deletion preserves the current version and its draft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, deletes = 0, deleted = false, completedRefreshes = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const row = { userId: 'fixture-user', jobId: 'outside-page', tone: 'professional', createdAt: time }
  const original = { ...row, id: 'selected-letter', content: 'Selected A' }
  const other = { ...row, id: 'other-letter', content: 'Other B' }
  const removing = { ...row, id: 'removing-letter', content: 'Removing C' }
  await page.route('**/api/jobs/outside-page/cover-letters', async route => { const afterDelete = deleted; await route.fulfill({ json: afterDelete ? [original, { ...other, tone: 'concise' }] : [original, other, removing] }); if (afterDelete) completedRefreshes++ })
  await page.route('**/api/cover-letters/removing-letter', async route => { deletes++; await gate; deleted = true; return route.fulfill({ json: {} }) })
  try {
    await page.goto(`${origin}/?page=multi-letter-panel-probe`)
    const first = page.getByTestId('first-letter-panel')
    const second = page.getByTestId('second-letter-panel')
    await expect(first.locator('textarea')).toHaveValue('Selected A')
    await expect(second.locator('textarea')).toHaveValue('Selected A')
    await page.clock.install()
    await first.locator('select').first().selectOption('removing-letter')
    await second.locator('select').first().selectOption('other-letter')
    await second.locator('textarea').fill('Unsaved B draft')
    await first.getByRole('button', { name: 'Delete', exact: true }).dispatchEvent('click')
    await first.getByText('Delete cover letter?', { exact: true }).locator('../..').getByRole('button', { name: 'Delete', exact: true }).dispatchEvent('click')
    await expect.poll(() => deletes).toBe(1)
    release()
    await expect.poll(() => completedRefreshes).toBeGreaterThanOrEqual(2)
    await expect(second.locator('textarea')).toHaveValue('Unsaved B draft')
    await expect(second.locator('select').first()).toHaveValue('other-letter')
    await expect(second.locator('select').first().locator('option[value="other-letter"]')).toContainText('concise')
    expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
    expect(deletes).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('a pending delete remains locked across a panel remount and refreshes the selected letter', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, deletes = 0, deleted = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const letter = { id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Original', tone: 'professional', createdAt: time }
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.fulfill({ json: deleted ? [] : [letter] }))
  await page.route('**/api/cover-letters/selected-letter', async route => { if (route.request().method() !== 'DELETE') return route.fallback(); deletes++; await gate; deleted = true; return route.fulfill({ json: {} }) })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await expect(page.locator('textarea')).toHaveValue('Original')
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByText('Delete cover letter?', { exact: true }).locator('../..').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => deletes).toBe(1)
    await page.getByRole('button', { name: 'Toggle panel' }).dispatchEvent('click')
    await page.getByRole('button', { name: 'Toggle panel' }).dispatchEvent('click')
    await expect(page.locator('textarea')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Generate letter', exact: true })).toBeDisabled()
    release()
    await expect(page.getByRole('alert')).toContainText('selected cover letter could not be loaded')
    expect(deletes).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('missing selected letter shows a usable retry on a narrow screen', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'Exercises narrow letter editor')
  const state = await install(page)
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  let retry = false
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.fulfill({ json: retry ? [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Selected letter', tone: 'professional', createdAt: time }] : [] }))
  await page.goto(`${origin}/?page=letter-panel-probe`)
  const notice = page.getByRole('alert')
  await expect(notice).toContainText(chinese ? '无法加载已选求职信' : 'selected cover letter could not be loaded')
  const button = notice.getByRole('button', { name: chinese ? '重试' : 'Try again' })
  await expect(button).toBeInViewport()
  retry = true
  await button.click()
  await expect(page.locator('textarea')).toHaveValue('Selected letter')
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('discarding an uncertain letter draft does not confirm an in-flight save', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, writes = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const letter = { id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', content: 'Original', tone: 'professional', createdAt: time }
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.fulfill({ json: [letter] }))
  await page.route('**/api/cover-letters/selected-letter', async route => { writes++; await gate; return route.fulfill({ json: { ...letter, content: 'Private pending edit' } }) })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    const editor = page.locator('textarea')
    await expect(editor).toHaveValue('Original')
    await page.clock.install()
    await editor.fill('Private pending edit')
    await page.clock.fastForward(1000)
    await expect.poll(() => writes).toBe(1)
    await page.clock.fastForward(15_001)
    await page.getByRole('button', { name: 'Discard local draft and reload' }).click()
    await expect(editor).toHaveValue('Original')
    await expect(editor).toBeDisabled()
    const checked = page.getByRole('button', { name: 'I checked the saved version' })
    await expect(checked).toBeDisabled()
    release()
    await expect(checked).toBeEnabled()
    await checked.click()
    await expect(editor).toBeEnabled()
    await page.clock.fastForward(2000)
    expect(writes).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('letter generation keeps the selected version fixed until the new draft is resolved', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const row = { userId: 'fixture-user', jobId: 'outside-page', tone: 'professional', createdAt: time }
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Unavailable' } }) : route.fulfill({ json: [{ ...row, id: 'selected-letter', content: 'Original' }, { ...row, id: 'other-letter', content: 'Other' }] }))
  await page.route('**/api/ai/cover-letter', async route => { await gate; return route.fulfill({ json: { coverLetter: 'Generated unsaved text' } }) })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await expect(page.locator('textarea')).toHaveValue('Original')
    await page.getByRole('button', { name: 'Generate letter', exact: true }).click()
    await expect(page.locator('select').first()).toBeDisabled()
    release()
    await expect(page.getByRole('alert').locator('textarea')).toHaveValue('Generated unsaved text')
    await page.getByRole('alert').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.locator('textarea')).toHaveValue('Original')
    expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(false)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

for (const mode of ['close', 'discard'] as const) test(`late ${mode} animation cannot close a new letter scope`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  await page.route('**/api/jobs/*/cover-letters', route => { const jobId = new URL(route.request().url()).pathname.split('/')[3]; return route.fulfill({ json: [{ id: 'selected-letter', userId: 'fixture-user', jobId, content: jobId === 'outside-page' ? 'Old job letter' : 'New job letter', tone: 'professional', createdAt: time }] }) })
  await page.route('**/api/cover-letters/selected-letter', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  await page.goto(`${origin}/?page=letter-panel-probe`)
  await expect(page.locator('textarea')).toHaveValue('Old job letter')
  if (mode === 'discard') {
    await page.locator('textarea').fill('Unsaved old draft')
    await expect(page.getByRole('button', { name: 'Discard local draft and close' })).toBeVisible()
  }
  await page.clock.install()
  await page.getByRole('button', { name: mode === 'close' ? '✕' : 'Discard local draft and close', exact: true }).click()
  await page.getByRole('button', { name: 'Switch panel job' }).dispatchEvent('click')
  await expect(page.locator('textarea')).toHaveValue('New job letter')
  await page.clock.fastForward(250)
  expect(await page.evaluate(() => (window as unknown as { __fixturePanelCloseCalls?: number }).__fixturePanelCloseCalls ?? 0)).toBe(0)
  await expect(page.locator('textarea')).toBeVisible()
  expect(state.unexpected).toEqual([])
})

test('a late cover letter PDF render cannot download the previous job after a scope change', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, fontStarted = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/jobs/*/cover-letters', route => { const jobId = new URL(route.request().url()).pathname.split('/')[3]; return route.fulfill({ json: [{ id: 'selected-letter', userId: 'fixture-user', jobId, content: jobId === 'outside-page' ? 'Old job letter' : 'New job letter', tone: 'professional', createdAt: time }] }) })
  await page.route('**/fonts/*', async route => { fontStarted = true; await gate; try { await route.continue() } catch { /* request can be cancelled */ } })
  await page.addInitScript(() => {
    const original = URL.createObjectURL.bind(URL)
    URL.createObjectURL = value => { (window as unknown as { fixtureUrls: number }).fixtureUrls = ((window as unknown as { fixtureUrls: number }).fixtureUrls || 0) + 1; return original(value) }
    const BaseBlob = window.Blob
    window.Blob = class extends BaseBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) { super(parts, options); if (options?.type === 'application/pdf') (window as unknown as { fixturePdfBlobs: number }).fixturePdfBlobs = ((window as unknown as { fixturePdfBlobs: number }).fixturePdfBlobs || 0) + 1 }
    }
  })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await expect(page.locator('textarea')).toHaveValue('Old job letter')
    await page.getByRole('button', { name: 'Download PDF', exact: true }).first().click()
    await expect.poll(() => fontStarted).toBe(true)
    await page.getByRole('button', { name: 'Switch panel job' }).dispatchEvent('click')
    await expect(page.locator('textarea')).toHaveValue('New job letter')
    release()
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixturePdfBlobs?: number }).fixturePdfBlobs ?? 0), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(await page.evaluate(() => (window as unknown as { fixtureUrls?: number }).fixtureUrls ?? 0)).toBe(0)
    await expect(page.getByRole('button', { name: 'Download PDF', exact: true }).first()).toBeEnabled()
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

for (const change of ['edit', 'version'] as const) test(`a late PDF render cannot download after a letter ${change}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop letter editor')
  const state = await install(page)
  let release = () => {}, started = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const row = { userId: 'fixture-user', jobId: 'outside-page', tone: 'professional', createdAt: time }
  await page.route('**/api/jobs/outside-page/cover-letters', route => route.fulfill({ json: [{ ...row, id: 'selected-letter', content: 'Original letter' }, { ...row, id: 'other-letter', content: 'Other version' }] }))
  await page.route('**/api/cover-letters/selected-letter', route => route.fulfill({ json: { ...row, id: 'selected-letter', content: 'Edited letter' } }))
  await page.route('**/fonts/*', async route => { started = true; await gate; try { await route.continue() } catch { /* request can be cancelled */ } })
  await page.addInitScript(() => {
    const original = URL.createObjectURL.bind(URL)
    URL.createObjectURL = value => { (window as unknown as { fixtureUrls: number }).fixtureUrls = ((window as unknown as { fixtureUrls: number }).fixtureUrls || 0) + 1; return original(value) }
    const BaseBlob = window.Blob
    window.Blob = class extends BaseBlob { constructor(parts?: BlobPart[], options?: BlobPropertyBag) { super(parts, options); if (options?.type === 'application/pdf') (window as unknown as { fixturePdfBlobs: number }).fixturePdfBlobs = ((window as unknown as { fixturePdfBlobs: number }).fixturePdfBlobs || 0) + 1 } }
  })
  try {
    await page.goto(`${origin}/?page=letter-panel-probe`)
    await expect(page.locator('textarea')).toHaveValue('Original letter')
    await page.getByRole('button', { name: 'Download PDF', exact: true }).first().click()
    await expect.poll(() => started).toBe(true)
    if (change === 'edit') await page.locator('textarea').fill('Edited letter')
    else { await page.locator('select').first().selectOption('other-letter'); await expect(page.locator('textarea')).toHaveValue('Other version') }
    release()
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixturePdfBlobs?: number }).fixturePdfBlobs ?? 0), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(await page.evaluate(() => (window as unknown as { fixtureUrls?: number }).fixtureUrls ?? 0)).toBe(0)
    await expect(page.getByRole('button', { name: 'Download PDF', exact: true }).first()).toBeEnabled()
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

for (const reloadFails of [false, true]) test(`uncertain Kanban change reloads the active page when list ${reloadFails ? 'fails' : 'succeeds'}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Kanban desktop interaction')
  const state = await install(page, { descriptionMode: 'two' })
  const listRequests: string[] = []
  let writeStarted = false
  let writeCount = 0
  await page.route('**/api/jobs?*', async route => {
    listRequests.push(route.request().url())
    if (writeStarted && reloadFails) return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    return route.fulfill({ json: { jobs: writeStarted ? [] : [{ ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role' }], total: 80, statusCounts: { saved: 79, interview: 1, applied: 0, offer: 0, rejected: 0 } } })
  })
  await page.route('**/api/jobs/job-2', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    writeCount++
    writeStarted = true
    return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
  })
  await page.goto(`${origin}/?page=jobs&jobsView=kanban&jobsPage=3&jobsSize=20&jobsSearch=Acme&jobsStatus=saved`)
  const card = page.locator('[data-col="saved"] [draggable="true"]').filter({ hasText: 'Second fixture role' })
  await expect(card).toBeVisible()
  await card.dragTo(page.locator('[data-col="interview"]'))
  await expect.poll(() => listRequests.length).toBeGreaterThan(1)
  const requested = new URL(listRequests.at(-1)!)
  expect(Object.fromEntries(requested.searchParams)).toMatchObject({ page: '3', pageSize: '20', q: 'Acme', status: 'saved' })
  await expect(page.getByRole('status').filter({ hasText: /status update may still be processing|状态更新可能仍在处理中/ })).toBeVisible()
  if (reloadFails) {
    await expect(page.getByText(/Check your connection and reload to confirm|请检查网络连接并重新加载/)).toBeVisible()
    await expect(page.getByText(/applications are unchanged|申请未改变/)).toHaveCount(0)
    await expect(page.locator('.jobs-page-header h1 + span')).toHaveText('—')
  } else {
    await expect(page.getByText('Second fixture role', { exact: true })).toHaveCount(0)
  }
  await page.getByRole('button', { name: /I have checked|我已核对/ }).click()
  await expect(page.getByRole('status').filter({ hasText: /status update may still be processing|状态更新可能仍在处理中/ })).toHaveCount(0)
  expect(writeCount).toBe(1)
  expect(state.unexpected).toEqual([])
})

for (const change of ['page', 'account'] as const) for (const outcome of ['success', 'unknown'] as const) test(`late Kanban ${outcome} respects the new ${change} list`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Kanban desktop interaction')
  const state = await install(page, { descriptionMode: 'two' })
  let releaseWrite = () => {}
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
  let writeStarted = false
  let writeFinished = false
  let writeCount = 0
  const reads: Array<{ owner: string; url: string }> = []
  await page.route('**/api/jobs?*', async route => {
    const url = new URL(route.request().url())
    const name = state.activeUserId === 'fixture-b' ? 'Account B employer' : url.searchParams.get('page') === '4' ? (writeFinished ? 'Updated page four employer' : 'Page four employer') : 'Second Employer'
    reads.push({ owner: state.activeUserId, url: url.href })
    return route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', userId: state.activeUserId, company: name, role: 'Second fixture role' }], total: 80, statusCounts: { saved: 80, interview: 0, applied: 0, offer: 0, rejected: 0 } } })
  })
  await page.route('**/api/jobs/job-2', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    writeCount++
    writeStarted = true
    await writeGate
    writeFinished = true
    return outcome === 'success' ? route.fulfill({ json: { id: 'job-2', status: 'interview' } }) : route.fulfill({ status: 503, json: { error: 'Unavailable' } })
  })
  try {
    await page.goto(`${origin}/?page=jobs&jobsView=kanban&jobsPage=3&jobsSize=20&jobsSearch=Acme&jobsStatus=saved`)
    const card = page.locator('[data-col="saved"] [draggable="true"]').filter({ hasText: 'Second fixture role' })
    await card.dragTo(page.locator('[data-col="interview"]'))
    await expect.poll(() => writeStarted).toBe(true)
    if (change === 'page') await page.getByRole('button', { name: '4', exact: true }).click()
    else { state.activeUserId = 'fixture-b'; await fixtureSession(page, 'authenticated', 'fixture-b') }
    const expected = change === 'page' ? 'Page four employer' : 'Account B employer'
    await expect(page.getByText(expected, { exact: true })).toBeVisible()
    const beforeRelease = reads.length
    const writeResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs/job-2' && response.request().method() === 'PATCH')
    releaseWrite()
    await writeResponse
    if (change === 'page') {
      await expect(page.getByText('Updated page four employer', { exact: true })).toBeVisible()
      await expect.poll(() => reads.length).toBeGreaterThan(beforeRelease)
      const refreshed = reads.at(-1)!
      expect(refreshed.owner).toBe('fixture-user')
      expect(Object.fromEntries(new URL(refreshed.url).searchParams)).toMatchObject({ page: '4', pageSize: '20', q: 'Acme', status: 'saved' })
      if (outcome === 'unknown') await expect(page.getByRole('status').filter({ hasText: /status update may still be processing|状态更新可能仍在处理中/ })).toBeVisible()
    } else {
      await page.waitForTimeout(250)
      await expect(page.getByText(expected, { exact: true })).toBeVisible()
      expect(reads.length).toBe(beforeRelease)
      await expect(page.getByRole('status').filter({ hasText: /status update may still be processing|状态更新可能仍在处理中/ })).toHaveCount(0)
    }
    expect(writeCount).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { releaseWrite() }
})

for (const change of ['page', 'account'] as const) test(`late recovery read cannot replace the new ${change} list`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile-'), 'Kanban desktop interaction')
  const state = await install(page, { descriptionMode: 'two' })
  let releaseOldRead = () => {}
  const oldReadGate = new Promise<void>(resolve => { releaseOldRead = resolve })
  let patchCompleted = false
  let oldReadStarted = false
  let oldReadReturned = false
  await page.route('**/api/jobs?*', async route => {
    const url = new URL(route.request().url())
    const owner = state.activeUserId
    const oldPage = owner === 'fixture-user' && url.searchParams.get('page') === '3'
    if (patchCompleted && oldPage) {
      oldReadStarted = true
      await oldReadGate
      try {
        await route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', company: 'Late old employer', role: 'Second fixture role' }], total: 80 } })
      } catch { /* The superseded request may already be aborted. */ }
      oldReadReturned = true
      return
    }
    const name = owner === 'fixture-b' ? 'Account B employer' : oldPage ? 'Original employer' : 'Page four employer'
    return route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', userId: owner, company: name, role: 'Second fixture role' }], total: 80, statusCounts: { saved: 80, interview: 0, applied: 0, offer: 0, rejected: 0 } } })
  })
  await page.route('**/api/jobs/job-2', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    patchCompleted = true
    return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
  })
  try {
    await page.goto(`${origin}/?page=jobs&jobsView=kanban&jobsPage=3&jobsSize=20`)
    const card = page.locator('[data-col="saved"] [draggable="true"]').filter({ hasText: 'Second fixture role' })
    await card.dragTo(page.locator('[data-col="interview"]'))
    await expect.poll(() => oldReadStarted).toBe(true)
    if (change === 'page') {
      await page.evaluate(() => {
        const url = new URL(window.location.href)
        url.searchParams.set('jobsPage', '4')
        window.history.pushState({}, '', url)
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
    } else { state.activeUserId = 'fixture-b'; await fixtureSession(page, 'authenticated', 'fixture-b') }
    const expected = change === 'page' ? 'Page four employer' : 'Account B employer'
    await expect(page.getByText(expected, { exact: true })).toBeVisible()
    releaseOldRead()
    await expect.poll(() => oldReadReturned).toBe(true)
    await expect(page.getByText(expected, { exact: true })).toBeVisible()
    await expect(page.getByText('Late old employer', { exact: true })).toHaveCount(0)
    if (change === 'account') await expect(page.getByRole('status').filter({ hasText: /status update may still be processing|状态更新可能仍在处理中/ })).toHaveCount(0)
    expect(state.unexpected).toEqual([])
  } finally { releaseOldRead() }
})

test('pending Kanban update blocks duplicate moves until the original request finishes', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop-'), 'Exercises desktop Kanban')
  const state = await install(page, { descriptionMode: 'two' })
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  let committed = false
  await page.route('**/api/jobs?*', route => committed ? route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role', status: 'interview' }], total: 1 } }) : route.fallback())
  await page.route('**/api/jobs/job-2', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    writes++
    await gate
    committed = true
    return route.fulfill({ json: { id: 'job-2', status: 'interview' } })
  })
  try {
    await page.goto(`${origin}/?page=jobs&jobsView=kanban`)
    await page.clock.install()
    const card = page.locator('[data-col="saved"] [draggable]').filter({ hasText: 'Second fixture role' })
    await card.dragTo(page.locator('[data-col="interview"]'))
    await expect.poll(() => writes).toBe(1)
    await expect(card).toHaveAttribute('draggable', 'false')
    await expect(card).toContainText(chinese ? '正在更新状态' : 'Updating status')
    await card.dispatchEvent('dragstart')
    await page.locator('[data-col="applied"]').dispatchEvent('drop')
    expect(writes).toBe(1)
    await page.clock.fastForward(15_001)
    await expect(page.getByText(chinese ? /状态更新可能仍在处理中/ : /status update may still be processing/)).toBeVisible()
    await expect(card).toHaveAttribute('draggable', 'false')
    await page.getByRole('button', { name: chinese ? /我已核对/ : /I have checked/ }).click()
    await expect(card).toHaveAttribute('draggable', 'false')
    await card.dispatchEvent('dragstart')
    await page.locator('[data-col="applied"]').dispatchEvent('drop')
    expect(writes).toBe(1)
    release()
    await expect(page.locator('[data-col="interview"]').getByText('Second fixture role')).toBeVisible()
    expect(writes).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

for (const failure of ['http', 'network'] as const) test(`uncertain ${failure} status cannot be moved again until checked`, async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop-'), 'Exercises desktop Kanban')
  const state = await install(page, { descriptionMode: 'two' })
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  let writes = 0, committed = false
  await page.route('**/api/jobs?*', route => committed ? route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role', status: 'interview' }], total: 1 } }) : route.fallback())
  await page.route('**/api/jobs/job-2', route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    writes++
    if (writes === 1) return failure === 'network' ? route.abort('failed') : route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    committed = true
    return route.fulfill({ json: { id: 'job-2', status: 'interview' } })
  })
  await page.goto(`${origin}/?page=jobs&jobsView=kanban`)
  const card = page.locator('[data-col="saved"] [draggable]').filter({ hasText: 'Second fixture role' })
  await card.dragTo(page.locator('[data-col="interview"]'))
  const notice = page.getByRole('status').filter({ hasText: chinese ? '状态更新可能仍在处理中' : 'status update may still be processing' })
  await expect(notice).toBeVisible()
  await expect(card).toHaveAttribute('draggable', 'false')
  await expect(card).toContainText(chinese ? '请先核对上方状态更新' : 'Check this status update above')
  await expect(card).not.toContainText(chinese ? '正在更新状态' : 'Updating status')
  await card.dispatchEvent('dragstart')
  await page.locator('[data-col="applied"]').dispatchEvent('drop')
  expect(writes).toBe(1)
  await notice.getByRole('button', { name: chinese ? /我已核对/ : /I have checked/ }).click()
  await expect(card).toHaveAttribute('draggable', 'true')
  await card.dragTo(page.locator('[data-col="interview"]'))
  await expect(page.locator('[data-col="interview"]').getByText('Second fixture role')).toBeVisible()
  expect(writes).toBe(2)
  expect(state.unexpected).toEqual([])
})

test('uncertain status updates identify and dismiss each job separately', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop-'), 'Exercises desktop Kanban')
  const state = await install(page, { descriptionMode: 'two' })
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const writes: string[] = []
  await page.route('**/api/jobs/*', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    writes.push(new URL(route.request().url()).pathname)
    await gate
    return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
  })
  try {
    await page.goto(`${origin}/?page=jobs&jobsView=kanban`)
    await page.locator('[data-col="saved"] [draggable]').filter({ hasText: 'Application flow engineer' }).dragTo(page.locator('[data-col="interview"]'))
    await page.locator('[data-col="saved"] [draggable]').filter({ hasText: 'Second fixture role' }).dragTo(page.locator('[data-col="interview"]'))
    await expect.poll(() => writes.length).toBe(2)
    release()
    const notices = page.getByRole('status').filter({ hasText: chinese ? /状态更新可能仍在处理中/ : /status update may still be processing/ })
    await expect(notices).toHaveCount(2)
    await notices.filter({ hasText: 'Fixture Employer' }).getByRole('button', { name: chinese ? /我已核对/ : /I have checked/ }).click()
    await expect(notices).toHaveCount(1)
    await expect(notices.first()).toContainText('Second Employer')
    expect(writes).toHaveLength(2)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('pending status lock survives leaving and returning within the same page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop shell')
  const state = await install(page, { descriptionMode: 'two' })
  let release = () => {}, writes = 0, committed = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/jobs?*', route => committed ? route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role', status: 'interview' }], total: 1 } }) : route.fallback())
  await page.route('**/api/jobs/job-2', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    writes++
    await gate
    committed = true
    return route.fulfill({ json: { id: 'job-2', status: 'interview' } })
  })
  try {
    await page.goto(`${origin}/?shell=1&page=jobs&jobsView=kanban`)
    const card = page.locator('[data-col="saved"] [draggable]').filter({ hasText: 'Second fixture role' })
    await card.dragTo(page.locator('[data-col="interview"]'))
    await expect.poll(() => writes).toBe(1)
    await page.locator('#desktop-sidebar').getByRole('button', { name: 'Discover', exact: true }).click()
    await page.locator('#desktop-sidebar').getByRole('button', { name: /^Applications(?:\s+\d+)?$/ }).click()
    const returned = page.locator('[data-col="saved"] [draggable]').filter({ hasText: 'Second fixture role' })
    await expect(returned).toHaveAttribute('draggable', 'false')
    await returned.dispatchEvent('dragstart')
    await page.locator('[data-col="applied"]').dispatchEvent('drop')
    expect(writes).toBe(1)
    release()
    await expect(page.locator('[data-col="interview"]').getByText('Second fixture role')).toBeVisible()
    expect(writes).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

test('a completed update invalidates cached list after leaving the page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the desktop shell')
  const state = await install(page, { descriptionMode: 'two' })
  let releaseWrite = () => {}, releaseRead = () => {}
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
  const readGate = new Promise<void>(resolve => { releaseRead = resolve })
  let started = false, committed = false, readStarted = false
  await page.route('**/api/jobs?*', async route => {
    if (!committed) return route.fallback()
    readStarted = true
    await readGate
    return route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role', status: 'interview' }], total: 1 } })
  })
  await page.route('**/api/jobs/job-2', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    started = true
    await writeGate
    committed = true
    return route.fulfill({ json: { id: 'job-2', status: 'interview' } })
  })
  try {
    await page.goto(`${origin}/?shell=1&page=jobs&jobsView=kanban`)
    const card = page.locator('[data-col="saved"] [draggable]').filter({ hasText: 'Second fixture role' })
    await card.dragTo(page.locator('[data-col="interview"]'))
    await expect.poll(() => started).toBe(true)
    await page.locator('#desktop-sidebar').getByRole('button', { name: 'Discover', exact: true }).click()
    await expect(page).toHaveURL(/page=search/)
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/jobs/job-2' && r.request().method() === 'PATCH')
    releaseWrite()
    await response
    await page.locator('#desktop-sidebar').getByRole('button', { name: /^Applications(?:\s+\d+)?$/ }).click()
    await expect.poll(() => readStarted).toBe(true)
    await expect(page.getByText('Second fixture role', { exact: true })).toHaveCount(0)
    releaseRead()
    await expect(page.locator('[data-col="interview"]').getByText('Second fixture role')).toBeVisible()
    expect(state.unexpected).toEqual([])
  } finally { releaseWrite(); releaseRead() }
})

test('a read started before a successful Kanban update cannot be the final list', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop Kanban')
  const state = await install(page, { descriptionMode: 'two' })
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let holdOld = false
  let oldStarted = false
  let committed = false
  await page.route('**/api/jobs?*', async route => {
    if (holdOld && !committed) {
      oldStarted = true
      await gate
      try { await route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role' }], total: 1 } }) } catch { /* superseded request may be aborted */ }
      return
    }
    return committed ? route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role', status: 'interview' }], total: 1 } }) : route.fallback()
  })
  await page.route('**/api/jobs/job-2', route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    committed = true
    return route.fulfill({ json: { id: 'job-2', status: 'interview' } })
  })
  try {
    await page.goto(`${origin}/?page=jobs&jobsView=kanban`)
    const card = page.locator('[data-col="saved"] [draggable]').filter({ hasText: 'Second fixture role' })
    await expect(card).toBeVisible()
    holdOld = true
    await page.evaluate(() => window.postMessage({ type: 'nav-refresh' }, '*'))
    await expect.poll(() => oldStarted).toBe(true)
    await card.dragTo(page.locator('[data-col="interview"]'))
    await expect(page.locator('[data-col="interview"]').getByText('Second fixture role')).toBeVisible()
    release()
    await expect(page.locator('[data-col="saved"]').getByText('Second fixture role')).toHaveCount(0)
  } finally { release() }
})

for (const nextSession of ['account', 'logout'] as const) test(`application list hides prior account during ${nextSession}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises account isolation')
  const state = await install(page, { descriptionMode: 'two' })
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let newRead = false
  await page.route('**/api/jobs?*', async route => {
    if (state.activeUserId !== 'fixture-b') return route.fallback()
    newRead = true
    await gate
    return route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-b', userId: 'fixture-b', company: 'Account B employer' }], total: 1 } })
  })
  try {
    await page.goto(`${origin}/?page=jobs&jobsSearch=Acme`)
    await expect(page.getByText('Fixture Employer', { exact: true }).first()).toBeVisible()
    await page.getByRole('table').getByRole('checkbox', { name: 'Select job: Fixture Employer · Application flow engineer' }).check()
    await expect(page.getByRole('button', { name: 'Delete 1', exact: true })).toBeVisible()
    state.activeUserId = 'fixture-b'
    await fixtureSession(page, nextSession === 'logout' ? 'unauthenticated' : 'authenticated', 'fixture-b')
    await expect(page.getByText('Fixture Employer', { exact: true })).toHaveCount(0)
    await expect(page.locator('.jobs-page-header h1 + span')).toHaveText('—')
    await expect(page.getByRole('button', { name: 'Delete 1', exact: true })).toHaveCount(0)
    if (nextSession === 'account') {
      await expect.poll(() => newRead).toBe(true)
      release()
      await expect(page.getByText('Account B employer', { exact: true }).first()).toBeVisible()
    }
  } finally { release() }
})

test('failed new-account read never exposes the prior account on retry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises account isolation')
  const state = await install(page, { descriptionMode: 'two' })
  let release = () => {}, reads = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/jobs?*', async route => {
    if (state.activeUserId !== 'fixture-b') return route.fallback()
    reads++
    if (reads === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    await gate
    return route.fulfill({ json: { jobs: [{ ...state.job, id: 'job-b', userId: 'fixture-b', company: 'Account B employer' }], total: 1 } })
  })
  try {
    await page.goto(`${origin}/?page=jobs`)
    await expect(page.getByText('Fixture Employer', { exact: true }).first()).toBeVisible()
    state.activeUserId = 'fixture-b'
    await fixtureSession(page, 'authenticated', 'fixture-b')
    await expect(page.getByText('Couldn’t load your jobs')).toBeVisible()
    await expect(page.getByText('Fixture Employer', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => reads).toBeGreaterThan(1)
    await expect(page.getByText('Fixture Employer', { exact: true })).toHaveCount(0)
    release()
    await expect(page.getByText('Account B employer', { exact: true }).first()).toBeVisible()
  } finally { release() }
})

test('application resume round trip survives an unavailable optional return cache', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const state = await install(page)
  await open(page, '&jobsPage=3&jobsSize=50&jobsSearch=Acme&jobsStatus=saved&jobsSort=score&jobsDirection=asc')
  await page.evaluate(() => {
    const set = Storage.prototype.setItem
    const remove = Storage.prototype.removeItem
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && key === 'applymate:resume-return') throw new Error('Optional cache unavailable')
      return set.call(this, key, value)
    }
    Storage.prototype.removeItem = function (key) {
      if (this === sessionStorage && key === 'applymate:resume-return') throw new Error('Optional cache unavailable')
      return remove.call(this, key)
    }
  })
  await page.getByRole('dialog').getByRole('button').filter({ has: page.getByText(/^(Resume|简历)$/) }).click()
  await page.getByRole('button', { name: /Edit this resume|编辑此简历/ }).click()
  await expect(page).toHaveURL(/page=resume/)
  await expect(page).toHaveURL(/resumeId=resume-1/)
  await expect(page).toHaveURL(/returnJobId=outside-page/)
  await expect(page.getByRole('button', { name: /Back to this application|返回此申请/ })).toBeVisible()
  await expect(page.locator('[data-resume-editor]')).toBeVisible()
  await page.getByRole('button', { name: /Back to this application|返回此申请/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  const returned = new URL(page.url())
  expect(Object.fromEntries(['page', 'highlight', 'jobsPage', 'jobsSize', 'jobsSearch', 'jobsStatus', 'jobsSort', 'jobsDirection'].map(key => [key, returned.searchParams.get(key)])))
    .toEqual({ page: 'jobs', highlight: 'outside-page', jobsPage: '3', jobsSize: '50', jobsSearch: 'Acme', jobsStatus: 'saved', jobsSort: 'score', jobsDirection: 'asc' })
  expect(pageErrors).toEqual([])
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
      await expect(page.getByText(/Application materials selected|已选择申请材料/)).toHaveCount(0)
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
    await expect(dialog.getByText(/Application materials selected|已选择申请材料/)).toHaveCount(0)
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
  expect(state.audit.coverLetterId).toBeNull()
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
    await expect(dialog).toContainText(/Application materials selected|已选择申请材料/)
    await expect(dialog.getByRole('button', { name: /Confirm application package|确认申请包/, exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /View this application|查看此申请/, exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
  }
  expect(state.writes).toEqual([])
  expect(state.analysisRequests).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('an unavailable audit in a clean resume can be refreshed without starting another audit', async ({ page }) => {
  const state = await install(page)
  let conflicting = false, auditPosts = 0
  await page.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() !== 'GET') { auditPosts++; return route.fallback() }
    return conflicting
      ? route.fulfill({ status: 409, json: { error: 'The application materials are being changed. Refresh the review status.' } })
      : route.fulfill({ json: state.audit })
  })
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  const editor = page.locator('[data-resume-editor]')
  await expect(editor.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
  const confirm = page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })
  const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
  await confirm.click()
  await expect(dialog).toContainText(/Application materials selected|已选择申请材料/)
  await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
  conflicting = true
  const conflictRead = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'GET' && response.status() === 409)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await conflictRead
  const unavailable = page.getByRole('status').filter({ hasText: /The review status could not be verified|无法核实审核状态/ }).first()
  await expect(unavailable).toBeVisible()
  await confirm.click()
  await expect(dialog).not.toContainText(/Application materials selected|已选择申请材料/)
  await expect(dialog.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
  conflicting = false
  await unavailable.getByRole('button', { name: /Refresh status|刷新状态/, exact: true }).click()
  await expect(unavailable).toHaveCount(0)
  await confirm.click()
  await expect(dialog).toContainText(/Application materials selected|已选择申请材料/)
  await expect(editor.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
  expect(auditPosts).toBe(0)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('resume editing defers audit reads and preserves the edit until the new version is stale', async ({ page }) => {
  const state = await install(page)
  // Preserve the old response even after fetch cancellation so the component's
  // scope/abort checks are exercised against a late, formerly passing result.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => typeof input === 'string' && input.endsWith('/audit-application')
      ? original(input, { ...init, signal: undefined }) : original(input, init)
  })
  let mode: 'normal' | 'conflict' | 'hold' | 'stale' = 'normal'
  let saveStarted = false, auditPosts = 0, auditGets = 0, oldReadStarted = false, oldReadReleased = false
  let releaseSave = () => {}, releaseOldRead = () => {}
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
  const oldReadGate = new Promise<void>(resolve => { releaseOldRead = resolve })
  const updatedAt = '2026-10-30T12:15:00.000Z'
  await page.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() !== 'GET') { auditPosts++; return route.fallback() }
    auditGets++
    if (mode === 'conflict') return route.fulfill({ status: 409, json: { error: 'The application materials are being changed. Refresh the review status.' } })
    if (mode === 'hold') { oldReadStarted = true; await oldReadGate; oldReadReleased = true; return route.fulfill({ json: state.audit }) }
    return route.fulfill({ json: mode === 'stale' ? { state: 'stale' } : state.audit })
  })
  await page.route('**/api/resume/resume-1', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    const body = route.request().postDataJSON() as { content: typeof state.resume.content }
    state.writes.push({ path: '/api/resume/resume-1', body })
    saveStarted = true
    await saveGate
    state.resume = { ...state.resume, content: body.content, updatedAt }
    return route.fulfill({ json: state.resume })
  })
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    const editor = page.locator('[data-resume-editor]')
    await expect(editor.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
    const confirm = page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })
    const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
    await confirm.click()
    await expect(dialog).toContainText(/Application materials selected|已选择申请材料/)
    await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()

    mode = 'conflict'
    const conflictRead = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'GET' && response.status() === 409)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await conflictRead
    const unavailable = page.getByRole('status').filter({ hasText: /The review status could not be verified|无法核实审核状态/ }).first()
    await expect(unavailable).toBeVisible()
    mode = 'hold'
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => oldReadStarted).toBe(true)
    await editor.getByText('Software engineer.', { exact: false }).first().click()
    const input = editor.locator('textarea').first()
    await input.fill('Software engineer with verified TypeScript experience.')
    await expect.poll(() => saveStarted).toBe(true)
    const readsWhileDirty = auditGets
    releaseOldRead()
    await expect.poll(() => oldReadReleased).toBe(true)
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
    await expect(unavailable).toBeVisible()
    await expect(input).toHaveValue('Software engineer with verified TypeScript experience.')
    await expect(unavailable.getByRole('button', { name: /Refresh status|刷新状态/, exact: true })).toBeDisabled()
    await expect(unavailable).toContainText(/Save your changes first.*review status.*automatically.*saved|请先保存.*保存完成后.*自动刷新审核状态/i)
    await expect(input).toHaveValue('Software engineer with verified TypeScript experience.')
    expect(auditGets).toBe(readsWhileDirty)
    expect(state.resume.content.summary).toBe('Software engineer.')
    expect(auditPosts).toBe(0)

    mode = 'stale'
    const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/resume/resume-1') && response.request().method() === 'PATCH')
    releaseSave()
    expect((await saveResponse).status()).toBe(200)
    await expect(page.locator('.resume-top-save')).toContainText(/Saved just now|刚刚保存/)
    expect(state.resume.content.summary).toBe('Software engineer with verified TypeScript experience.')
    await expect.poll(() => auditGets).toBeGreaterThan(readsWhileDirty)
    await expect(page.getByRole('status').filter({ hasText: /The job or materials have changed, or this older review can no longer be verified|职位或材料已变化，或旧审核已无法核实/ }).first()).toBeVisible()
    await expect(unavailable).toHaveCount(0)
    await expect(input).toHaveValue('Software engineer with verified TypeScript experience.')
    await confirm.click()
    await expect(dialog).not.toContainText(/Application materials selected|已选择申请材料/)
    await expect(dialog.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
    expect(auditPosts).toBe(0)
    expect(state.writes.map(write => write.path)).toEqual(['/api/resume/resume-1'])
    expect(state.unexpected).toEqual([])
  } finally { releaseSave(); releaseOldRead() }
})

for (const fenceState of ['pending', 'confirmed'] as const) {
  test(`resume editing preserves a ${fenceState} review fence without starting another review`, async ({ page }) => {
    const state = await install(page)
    let auditGets = 0, auditPosts = 0, saveStarted = false, saved = false
    let releaseSave = () => {}
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
    await page.route('**/api/jobs/outside-page/audit-application', async route => {
      if (route.request().method() !== 'GET') { auditPosts++; return route.fallback() }
      auditGets++
      return route.fulfill({ json: saved ? { state: 'stale' } : state.audit })
    })
    await page.route('**/api/resume/resume-1', async route => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      const body = route.request().postDataJSON() as { content: typeof state.resume.content }
      state.writes.push({ path: '/api/resume/resume-1', body })
      saveStarted = true
      await saveGate
      state.resume = { ...state.resume, content: body.content, updatedAt: '2026-10-30T12:15:00.000Z' }
      saved = true
      return route.fulfill({ json: state.resume })
    })
    try {
      await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
      const editor = page.locator('[data-resume-editor]')
      await expect(editor.getByText('Software engineer.', { exact: false }).first()).toBeVisible()
      const confirm = page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })
      const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
      await confirm.click()
      await expect(dialog).toContainText(/Application materials selected|已选择申请材料/)
      await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
      await editor.getByText('Software engineer.', { exact: false }).first().click()
      const input = editor.locator('textarea').first()
      await input.fill('Software engineer with verified TypeScript experience.')
      await expect.poll(() => saveStarted).toBe(true)
      const readsWhileSaving = auditGets
      const marker = { version: 1, state: fenceState, attemptId: '123e4567-e89b-42d3-a456-426614174001', resumeId: 'resume-1', coverLetterId: null,
        ...(fenceState === 'confirmed' ? { operationId: fixtureAuditOperation, resumeUpdatedAt: time, coverLetterUpdatedAt: null, digest: 'a'.repeat(64) } : {}) }
      const fenceKey = 'applymate:audit-fence:fixture-user:outside-page'
      await page.evaluate(({ fenceKey, marker }) => {
        sessionStorage.setItem(fenceKey, JSON.stringify(marker))
        window.dispatchEvent(new Event('applymate:application-audit-fence'))
        window.dispatchEvent(new Event('focus'))
      }, { fenceKey, marker })
      const pending = page.getByRole('status').filter({ hasText: /This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i }).first()
      await expect(pending).toBeVisible()
      await expect(pending.getByRole('button', { name: /Refresh status|刷新状态/, exact: true })).toBeDisabled()
      await expect(input).toHaveValue('Software engineer with verified TypeScript experience.')
      expect(auditGets).toBe(readsWhileSaving)
      expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), fenceKey)).toEqual(marker)

      const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/resume/resume-1') && response.request().method() === 'PATCH')
      releaseSave()
      expect((await saveResponse).status()).toBe(200)
      await expect(page.locator('.resume-top-save')).toContainText(/Saved just now|刚刚保存/)
      if (fenceState === 'confirmed') await expect.poll(() => auditGets).toBeGreaterThan(readsWhileSaving)
      else { await page.waitForTimeout(250); expect(auditGets).toBe(readsWhileSaving) }
      await expect(pending).toBeVisible()
      await expect(input).toHaveValue('Software engineer with verified TypeScript experience.')
      expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), fenceKey)).toEqual(marker)
      await confirm.click()
      await expect(dialog).not.toContainText(/Application materials selected|已选择申请材料/)
      await expect(dialog.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
      expect(auditPosts).toBe(0)
      expect(state.writes.map(write => write.path)).toEqual(['/api/resume/resume-1'])
      expect(state.unexpected).toEqual([])
    } finally { releaseSave() }
  })
}

for (const surface of ['jobs', 'resume'] as const) {
  for (const status of ['pending', 'stale'] as const) test(`${surface} hides an old passing audit while the server reports ${status}`, async ({ page }) => {
    const state = await install(page)
    let blocked = false
    await page.route('**/api/jobs/outside-page/audit-application', async route => {
      if (route.request().method() !== 'GET') return route.fallback()
      return route.fulfill({ json: blocked ? { state: status } : state.audit })
    })
    if (surface === 'jobs') {
      await open(page)
      await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toBeVisible()
    } else {
      await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
      await expect(page.locator('.resume-opportunity-card')).toContainText('Application flow engineer')
      await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
      await expect(page.getByRole('dialog')).toContainText(/Application materials selected|已选择申请材料/)
      await page.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
    }
    blocked = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const warning = status === 'pending' ? /A review is still in progress or its result is unknown|审核仍在进行或结果尚未确认/ : /The job or materials have changed, or this older review can no longer be verified|职位或材料已变化，或旧审核已无法核实/
    await expect(page.getByText(warning)).toBeVisible()
    if (surface === 'jobs') await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
    else {
      await page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true }).click()
      await expect(page.getByRole('dialog')).not.toContainText(/Application materials selected|已选择申请材料/)
      await page.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
    }
    await page.reload()
    await expect(page.getByText(warning)).toBeVisible()
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

for (const transition of ['switch', 'reload'] as const) test(`unregistered Resume review remains fenced after ${transition}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises authenticated-style shell navigation with synthetic APIs')
  const state = await install(page, { descriptionMode: 'two' })
  let release = () => {}, posted = false, registered = false, postCount = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const nextOperation = '123e4567-e89b-42d3-a456-426614174001'
  const oldAudit = state.audit
  const reviewed = { ...state.audit, operationId: nextOperation, audit: { ...state.audit.audit, summary: 'Newly completed review' } }
  await page.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: registered ? reviewed : oldAudit })
    posted = true; postCount++
    await gate
    registered = true
    try { await route.fulfill({ json: { ...reviewed.audit, operationId: nextOperation, resumeUpdatedAt: reviewed.resumeUpdatedAt } }) } catch { /* navigation may cancel the client request */ }
  })
  try {
    await page.goto(`${origin}/?shell=1&page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await expect(page.locator('.resume-opportunity-card')).toContainText('Application flow engineer')
    await page.getByRole('button', { name: /Run independent audit|Run audit again/ }).click()
    await expect.poll(() => posted).toBe(true)
    if (transition === 'switch') {
      await page.locator('#desktop-sidebar').getByRole('button', { name: /^Applications(?:\s+\d+)?$/ }).click()
      const row = page.getByRole('row').filter({ hasText: 'Application flow engineer' })
      await row.getByRole('button', { name: 'View this application' }).click()
      await expect(page.getByRole('dialog')).toContainText('This tab has an unconfirmed review request')
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Download application materials' })).toHaveCount(0)
      await page.goBack()
    } else await page.reload()
    await expect(page.getByText('This tab has an unconfirmed review request', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Confirm application materials', exact: true }).click()
    await expect(page.getByRole('dialog')).not.toContainText('Application materials selected')
    await page.getByRole('button', { name: 'Close final confirmation' }).click()
    expect(postCount).toBe(1)
    if (transition === 'switch') {
      release()
      await expect.poll(() => registered).toBe(true)
      await expect(page.getByText('Newly completed review', { exact: false }).first()).toBeVisible()
    }
    expect(postCount).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

for (const outcome of ['loading', 'failed'] as const) {
  test(`Resume re-audit does not omit a selected cover letter while its read is ${outcome}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'Focused selected material regression')
    const state = await install(page, { selectedLetter: true })
    state.job.finalCoverLetterId = 'selected-letter'
    state.audit = { ...audit(time, true), coverLetterId: 'selected-letter', coverLetterUpdatedAt: time }
    let releaseLetters = () => {}
    const lettersGate = new Promise<void>(resolve => { releaseLetters = resolve })
    let lettersStarted = false
    await page.route('**/api/jobs/outside-page/cover-letters', async route => {
      lettersStarted = true
      if (outcome === 'loading') await lettersGate
      if (outcome === 'failed') return route.fulfill({ status: 500, json: { error: 'Fixture letter unavailable' } })
      return route.fulfill({ json: [{ id: 'selected-letter', userId: 'fixture-user', jobId: 'outside-page', resumeId: 'resume-1', content: 'Selected letter', updatedAt: time }] })
    })
    const failedResponse = outcome === 'failed' ? page.waitForResponse(response => response.url().endsWith('/cover-letters') && response.status() === 500) : null
    try {
      await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
      await expect.poll(() => lettersStarted).toBe(true)
      if (failedResponse) await failedResponse
      await page.getByRole('button', { name: /Run independent audit|Run audit again|运行独立审核|再次运行审核/ }).click()
      await expect(page.getByText(outcome === 'loading' ? /selected cover letter is still loading/i : /selected cover letter could not be loaded/i).first()).toBeVisible()
      expect(state.writes.filter(write => write.path.endsWith('/audit-application'))).toHaveLength(0)
      expect(state.job.finalCoverLetterId).toBe('selected-letter')
    } finally { releaseLetters() }
  })
}

for (const reviewCase of ['verified', 'different-operation', 'missing-post-operation', 'invalid-post-operation'] as const) {
  test(`Resume review binds its canonical response to the submitted operation: ${reviewCase}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'Exercises Resume audit operation handoff')
    const state = await install(page)
    let posted = false
    let canonicalReads = 0
    await page.route('**/api/jobs/outside-page/audit-application', async route => {
      if (route.request().method() === 'POST') {
        posted = true
        state.writes.push({ path: '/api/jobs/outside-page/audit-application', body: route.request().postDataJSON() })
        return route.fulfill({ json: { ...state.audit.audit, resumeUpdatedAt: state.audit.resumeUpdatedAt,
          ...(reviewCase === 'missing-post-operation' ? {} : { operationId: reviewCase === 'invalid-post-operation' ? 'invalid' : fixtureAuditOperation }) } })
      }
      if (posted) canonicalReads++
      return route.fulfill({ json: { ...state.audit, operationId: posted && reviewCase === 'different-operation' ? '123e4567-e89b-42d3-a456-426614174001' : fixtureAuditOperation } })
    })
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    const openConfirmation = page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })
    const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
    await expect(openConfirmation).toBeVisible()
    await page.getByRole('button', { name: /Run independent audit|Run audit again|运行独立审核|再次运行审核/ }).click()
    await expect.poll(() => posted).toBe(true)
    if (reviewCase === 'missing-post-operation' || reviewCase === 'invalid-post-operation') {
      await expect(page.getByText(/This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i).first()).toBeVisible()
    } else {
      await expect.poll(() => canonicalReads).toBeGreaterThan(0)
      if (reviewCase === 'different-operation') await expect(page.getByText(/This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i).first()).toBeVisible()
    }
    await openConfirmation.click()
    if (reviewCase === 'verified') await expect(dialog).toContainText(/Application materials selected|已选择申请材料/)
    else {
      await expect(dialog).not.toContainText(/Application materials selected|已选择申请材料/)
      await expect(dialog.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
    }
    expect(state.writes.filter(write => write.path.endsWith('/audit-application'))).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  })
}

for (const outcome of ['failed', 'verified', 'stale'] as const) {
  test(`Resume re-audit ${outcome} does not reuse the previous passing receipt`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'Focused Resume audit regression')
    const state = await install(page)
    const oldAudit = structuredClone(state.audit)
    const newAudit = { ...oldAudit, operationId: '123e4567-e89b-42d3-a456-426614174001', receipt: { version: 1 as const, signature: 'b'.repeat(64) }, audit: { ...oldAudit.audit, auditedAt: '2026-10-30T10:05:00.000Z', summary: 'New verified audit' } }
    let postStarted = false
    let canonicalStarted = false
    let releasePost = () => {}
    let releaseCanonical = () => {}
    const postGate = new Promise<void>(resolve => { releasePost = resolve })
    const canonicalGate = new Promise<void>(resolve => { releaseCanonical = resolve })
    await page.route('**/api/jobs/outside-page/audit-application', async route => {
      if (route.request().method() === 'POST') {
        postStarted = true
        await postGate
        return outcome === 'failed'
          ? route.fulfill({ status: 502, json: { error: 'Audit response unavailable' } })
          : route.fulfill({ json: { ...newAudit.audit, operationId: newAudit.operationId, resumeUpdatedAt: newAudit.resumeUpdatedAt } })
      }
      if (postStarted && outcome !== 'failed') {
        canonicalStarted = true
        await canonicalGate
        return route.fulfill({ json: outcome === 'verified' ? newAudit : oldAudit })
      }
      return route.fulfill({ json: oldAudit })
    })
    try {
      await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
      const openConfirmation = page.getByRole('button', { name: /Confirm application materials|确认申请材料/, exact: true })
      const dialog = page.getByRole('dialog', { name: /Confirm application materials|确认申请材料/ })
      await openConfirmation.click()
      await expect(dialog).toContainText(/Application materials selected|已选择申请材料/)
      await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
      await page.getByRole('button', { name: /Run independent audit|Run audit again|运行独立审核|再次运行审核/ }).click()
      await expect.poll(() => postStarted).toBe(true)
      await openConfirmation.click()
      await expect(dialog).not.toContainText(/Application materials selected|已选择申请材料/)
      await expect(dialog.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
      await dialog.getByRole('button', { name: /Close final confirmation|关闭最终确认/ }).click()
      const postResponse = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'POST')
      releasePost()
      await postResponse
      if (outcome !== 'failed') await expect.poll(() => canonicalStarted).toBe(true)
      await openConfirmation.click()
      await expect(dialog).not.toContainText(/Application materials selected|已选择申请材料/)
      if (outcome === 'verified') {
        releaseCanonical()
        await expect(dialog).toContainText(/Application materials selected|已选择申请材料/)
      } else if (outcome === 'stale') {
        const staleResponse = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'GET')
        releaseCanonical()
        await staleResponse
        await expect(dialog).not.toContainText(/Application materials selected|已选择申请材料/)
        await expect(dialog.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
      } else {
        await expect(page.getByText(/This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i).first()).toBeVisible()
        await expect(dialog.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
        await expect(dialog).not.toContainText(/Application materials selected|已选择申请材料/)
      }
    } finally { releasePost(); releaseCanonical() }
  })
}

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

for (const coverage of ['loading', 'unavailable', 'limited'] as const) {
  test(`application next action reflects ${coverage} task coverage`, async ({ page }) => {
    const state = await install(page, { firstPreparation: true, holdFirstTaskRead: coverage === 'loading',
      taskStatus: coverage === 'loading' ? 'waiting_for_user' : undefined,
      taskFailure: coverage === 'unavailable', taskLimited: coverage === 'limited' })
    try {
      await open(page)
      const drawer = page.getByRole('dialog')
      const title = coverage === 'loading' ? /^(Checking task status|正在检查任务状态)$/
        : coverage === 'unavailable' ? /^(Task status unavailable|暂时无法读取任务状态)$/
          : /^(Task coverage is limited|任务覆盖范围有限)$/
      await expect(drawer.getByText(title, { exact: true })).toBeVisible()
      await expect(drawer.getByText(/^(Tailor your resume for this job|为该职位定制简历)$/)).toHaveCount(0)
      await expect(drawer.getByRole('button', { name: /^(Prepare application materials|准备申请材料)$/ })).toHaveCount(0)
      if (coverage === 'loading') {
        await expect(drawer.getByText(/Checking the latest task status\. Please wait|正在检查最新任务状态，请稍候/).first()).toBeVisible()
        await expect(drawer.getByText(title, { exact: true }).locator('..').locator(':scope > div[role="status"]').getByRole('button')).toHaveCount(0)
        await expect(drawer.getByRole('button', { name: /^(Refresh task status|刷新任务状态)$/ })).toHaveCount(0)
        state.releaseFirstTaskRead()
        await expect(drawer.getByText(/^(Application progress|申请进展)$/)).toBeVisible()
        await expect(drawer.getByRole('link', { name: /Continue in the original task|进入原任务处理/ })).toHaveCount(1)
      } else {
        const readsBefore = state.taskReads
        await drawer.getByRole('button', { name: /^(Refresh status|刷新状态)$/ }).first().click()
        await expect.poll(() => state.taskReads).toBeGreaterThan(readsBefore)
        await expect(drawer.getByText(title, { exact: true })).toBeVisible()
      }
      expect(state.writes).toEqual([])
      expect(state.agentRequests.filter(item => item.method === 'POST')).toEqual([])
      expect(state.unexpected).toEqual([])
    } finally { state.releaseFirstTaskRead() }
  })
}

test('recorded application keeps its existing record as the next action when task status is unavailable', async ({ page }) => {
  const state = await install(page, { recordedInitially: true, taskFailure: true })
  await open(page)
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText(/^(Application record|申请记录)$/)).toBeVisible()
  await expect(drawer.getByText(/^(Task status unavailable|暂时无法读取任务状态)$/)).toHaveCount(0)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const status of ['applied', 'interview'] as const) {
  for (const coverage of ['unavailable', 'limited'] as const) {
    test(`${status} application can refresh ${coverage} task status without changing its record`, async ({ page }) => {
      const state = await install(page, { taskFailure: coverage === 'unavailable', taskLimited: coverage === 'limited' })
      state.job.status = status
      await open(page)
      const drawer = page.getByRole('dialog')
      const title = status === 'applied' ? /^(Application record|申请记录)$/ : /^(Review application status|核对申请状态)$/
      await expect(drawer.getByText(title)).toBeVisible()
      await expect(drawer).toContainText(/The Agent task status cannot be confirmed|无法确认此职位的 Agent 任务状态/)
      const refresh = drawer.getByRole('button', { name: /^(Refresh task status|刷新任务状态)$/ })
      const readsBefore = state.taskReads
      await refresh.click()
      await expect.poll(() => state.taskReads).toBeGreaterThan(readsBefore)
      await expect(drawer.getByText(title)).toBeVisible()
      await expect(refresh).toBeVisible()
      await expect(drawer).not.toContainText(/No Agent task is linked to this job|此职位没有关联的 Agent 任务/)
      expect(state.writes).toEqual([])
      expect(state.agentRequests.filter(item => item.method === 'POST')).toEqual([])
      expect(state.unexpected).toEqual([])
    })
  }
}

test('known task remains the next action when recent task coverage is limited', async ({ page }) => {
  const state = await install(page)
  await page.route('**/api/agent/application-tasks', route => route.fulfill({ json: { tasks: Array.from({ length: 100 }, (_, i) => ({
    id: `task-${i}`, userId: 'fixture-user', jobId: i === 0 ? 'outside-page' : `other-job-${i}`,
    sessionId: `session-${i}`, status: i === 0 ? 'waiting_for_user' : 'filling',
    checkpoint: i === 0 ? 'form_answer_required' : null, updatedAt: time,
    job: { company: 'Fixture Employer', role: 'Application flow engineer' },
  })) } }))
  await open(page)
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText(/^(Application progress|申请进展)$/)).toBeVisible()
  await expect(drawer.getByRole('link', { name: /Continue in the original task|进入原任务处理/ })).toHaveCount(1)
  await expect(drawer.getByText(/^(Task coverage is limited|任务覆盖范围有限)$/)).toHaveCount(0)
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
      await expect(card).not.toContainText(/Your action is needed|需要你处理/)
      const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/agent/application-tasks') && response.request().method() === 'GET')
      state.releaseFirstTaskRead()
      await oldResponse
      await expect.poll(() => state.firstTaskReadFinished).toBe(true)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(card).toContainText(/Review needed|等待审核/)
      await expect(card).not.toContainText(/Your action is needed|需要你处理/)
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
      await expect(firstCard).toContainText('Your action is needed')
      state.activeUserId = 'fixture-b'
      await fixtureSession(page, 'authenticated', 'fixture-b')
      await expect(page.getByRole('region', { name: 'Fixture B · Engineer B' })).toContainText('Review needed')
      await expect(firstCard).toHaveCount(0)
      await page.evaluate(() => {
        const values: string[] = []
        ;(window as unknown as { __taskLeak: string[] }).__taskLeak = values
        const observer = new MutationObserver(records => {
          for (const record of records) for (const node of record.addedNodes) {
            if (node.textContent?.includes('Your action is needed')) values.push(node.textContent)
          }
          if (document.body.textContent?.includes('Your action is needed')) values.push('visible')
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
      await expect(firstCard).not.toContainText('Your action is needed')
      expect(await page.evaluate(() => (window as unknown as { __taskLeak: string[] }).__taskLeak)).toEqual([])
      expect(state.writes).toEqual([])
      expect(state.unexpected).toEqual([])
    } finally { state.releaseReturnOwnerA() }
  })
}

for (const scenario of [
  { status: 'submitted', label: /Submission recorded|已有提交记录/, session: true },
  { status: 'cancelled', label: /Task cancelled|任务已取消/, session: true },
  { status: 'skipped', label: /Application skipped|已跳过此申请/, session: true },
  { status: 'unrecognized-status', label: /Status needs refreshing|状态待刷新/, session: true },
  { status: 'submitted', label: /Submission recorded|已有提交记录/, session: false },
  { status: 'unknown', label: /Submission outcome unverified|提交结果待核实/, session: false },
] as const) {
  test(`dashboard shows ${scenario.status} task with ${scenario.session ? 'the original session' : 'no session'}`, async ({ page }) => {
    const state = await install(page)
    await page.route('**/api/agent/application-tasks', route => route.fulfill({ json: { tasks: [{
      id: 'task-1', userId: 'fixture-user', jobId: 'outside-page', sessionId: scenario.session ? 'original-session' : null,
      status: scenario.status, checkpoint: null, updatedAt: time,
      job: { company: 'Fixture Employer', role: 'Application flow engineer' },
    }] } }))
    await page.route('**/api/dashboard**', route => route.fulfill({ json: {
      stats: { total: 1, saved: 1, applied: 0, inProgress: 0, interviews: 0, offers: 0, rejected: 0, thisWeek: 0 },
      savedJobs: [{ id: 'outside-page', company: 'Fixture Employer', role: 'Application flow engineer', score: 82, createdAt: time, url: null }],
      followUpsDue: scenario.status === 'submitted' ? [{ id: 'outside-page', company: 'Fixture Employer', role: 'Application flow engineer', status: 'applied', followUpAt: time }] : [],
      activity: [], applicationDays: [], interviewsScheduled: [], todayRecommendations: [], agentConfig: null, hasResume: true,
    } }))
    await page.goto(`${origin}/?page=dashboard`)
    const guidance = page.locator('.application-dashboard-guidance')
    const card = guidance.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })
    await expect(card).toContainText(scenario.label)
    await expect(guidance).not.toContainText(/Continue preparing this application|继续准备此申请/)
    await expect(card).not.toContainText(/employer (?:confirmed|receipt)|雇主已确认|雇主回执/i)
    if (scenario.status === 'submitted') await expect(guidance.getByRole('button', { name: /Follow-up due|待跟进/ })).toBeVisible()
    if (scenario.session) {
      const link = card.getByRole('link', { name: /View task activity|查看任务记录/ })
      await expect(link).toHaveAttribute('href', '/?page=agent&sessionId=original-session')
      await link.click()
      await expect(page.getByTestId('agent-destination')).toHaveText('original-session')
    } else {
      await expect(card).toContainText(/The original session is unavailable|暂时无法打开原会话/)
      await expect(card.getByRole('link')).toHaveCount(0)
      const applicationLink = guidance.getByRole('link', { name: /View this application|查看此申请/ })
      await expect(applicationLink).toHaveAttribute('href', '/?page=jobs&highlight=outside-page')
      await applicationLink.click()
      await expect(page).toHaveURL(/highlight=outside-page/)
      await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
    }
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('dashboard limits recent task cards and opens the unfiltered Applications list', async ({ page }) => {
  const state = await install(page)
  await page.route('**/api/agent/application-tasks', route => route.fulfill({ json: { tasks: [
    ['submitted', 'task-a', 'job-a', 'Employer A'],
    ['waiting_for_user', 'task-b', 'job-b', 'Employer B'],
    ['filling', 'task-c', 'job-c', 'Employer C'],
    ['skipped', 'task-d', 'job-d', 'Employer D'],
  ].map(([status, id, jobId, company]) => ({ id, userId: 'fixture-user', jobId, sessionId: `session-${id}`,
    status, checkpoint: null, updatedAt: time, job: { company, role: 'Fixture Role' } })) } }))
  await page.goto(`${origin}/?page=dashboard&jobsAttention=1&jobsSearch=NotFound&jobsStatus=interview&jobsPage=3&highlight=stale-job`)
  const guidance = page.locator('.application-dashboard-guidance')
  for (const company of ['Employer A', 'Employer B', 'Employer C']) await expect(guidance.getByRole('region', { name: `${company} · Fixture Role` })).toBeVisible()
  await expect(guidance.getByRole('region', { name: 'Employer D · Fixture Role' })).toHaveCount(0)
  await expect(guidance).toContainText(/Only three recent tasks are shown here|此处仅显示三个近期任务/)
  const all = guidance.getByRole('link', { name: /^(All applications|全部申请)$/ })
  await expect(all).toHaveAttribute('href', '/?page=jobs')
  const originalUrl = page.url()
  const newTab = page.context().waitForEvent('page')
  await all.click({ modifiers: ['Control'] })
  const openedTab = await newTab
  await expect(openedTab).toHaveURL(/\?page=jobs$/)
  await openedTab.close()
  await expect(page).toHaveURL(originalUrl)
  await page.evaluate(() => { (window as unknown as { __fixtureBlockNavigation: boolean }).__fixtureBlockNavigation = true })
  await all.click()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(page).toHaveURL(originalUrl)
  await expect(guidance).toBeVisible()
  await page.evaluate(() => { (window as unknown as { __fixtureBlockNavigation: boolean }).__fixtureBlockNavigation = false })
  await all.click()
  await expect(page).toHaveURL(/page=jobs/)
  const query = new URL(page.url()).searchParams
  for (const key of ['highlight', 'jobsAttention', 'jobsSearch', 'jobsStatus', 'jobsPage']) {
    if (key === 'jobsSearch') expect(query.get(key) ?? '').toBe('')
    else if (key === 'jobsStatus') expect(query.get(key) ?? 'all').toBe('all')
    else if (key === 'jobsPage') expect(query.get(key) ?? '1').toBe('1')
    else expect(query.has(key)).toBe(false)
  }
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('dashboard retains bounded coverage notice alongside a known terminal task', async ({ page }) => {
  const state = await install(page)
  await page.route('**/api/agent/application-tasks', route => route.fulfill({ json: { tasks: Array.from({ length: 100 }, (_, i) => ({
    id: `task-${i}`, userId: 'fixture-user', jobId: `job-${i}`, sessionId: `session-${i}`,
    status: 'submitted', checkpoint: null, updatedAt: time, job: { company: `Employer ${i}`, role: 'Fixture Role' },
  })) } }))
  await page.goto(`${origin}/?page=dashboard`)
  const guidance = page.locator('.application-dashboard-guidance')
  await expect(guidance.getByRole('region', { name: 'Employer 0 · Fixture Role' })).toContainText(/Submission recorded|已有提交记录/)
  await expect(guidance).toContainText(/Some task statuses may be outside this list|部分任务状态可能不在此列表中/)
  await expect(guidance).toContainText(/Only three recent tasks are shown here|此处仅显示三个近期任务/)
  await expect(guidance).not.toContainText(/Continue preparing this application|继续准备此申请/)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('dashboard refreshes its original task after returning from the Agent workspace', async ({ page }) => {
  const state = await install(page)
  let status = 'waiting_for_user'
  await page.route('**/api/agent/application-tasks', route => route.fulfill({ json: { tasks: [{
    id: 'task-1', userId: 'fixture-user', jobId: 'outside-page', sessionId: 'original-session', status,
    checkpoint: status === 'waiting_for_user' ? 'form_answer_required' : null, updatedAt: time,
    job: { company: 'Fixture Employer', role: 'Application flow engineer' },
  }] } }))
  await page.goto(`${origin}/?page=dashboard`)
  const card = page.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })
  await card.getByRole('link', { name: /Continue in the original task|进入原任务处理/ }).click()
  await expect(page.getByTestId('agent-destination')).toHaveText('original-session')
  status = 'submitted'
  await page.getByRole('button', { name: 'Fixture dashboard' }).click()
  await expect(card).toContainText(/Submission recorded|已有提交记录/)
  await expect(card.getByRole('link', { name: /View task activity|查看任务记录/ })).toHaveAttribute('href', '/?page=agent&sessionId=original-session')
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

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

for (const scenario of [
  { checkpoint: 'materials_ready', label: /Materials ready for review|材料已准备，等待审核/, action: /Review materials in Agent|前往 Agent 审核材料/ },
  { checkpoint: 'user_takeover', label: /Your help is needed|需要你接手/, action: /Open handoff in Agent|前往 Agent 接手/ },
  { checkpoint: 'form_answer_required', label: /Your action is needed|需要你处理/, action: /Continue in the original task|进入原任务处理/ },
  { checkpoint: 'fill_outcome_uncertain', label: /Form-filling outcome unverified|表单填写结果待核实/, action: /View task activity|查看任务记录/ },
  { checkpoint: null, label: /Action needed|需要处理/, action: /View task activity|查看任务记录/ },
] as const) {
  test(`waiting task ${scenario.checkpoint ?? 'unspecified'} has consistent guidance`, async ({ page }) => {
    const state = await install(page, { taskStatus: 'waiting_for_user', taskCheckpoint: scenario.checkpoint })
    await page.goto(`${origin}/?page=dashboard`)
    const dashboardCard = page.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })
    await expect(dashboardCard).toContainText(scenario.label)
    await expect(dashboardCard.getByRole('link', { name: scenario.action })).toHaveAttribute('href', '/?page=agent&sessionId=original-session')
    await open(page)
    const drawer = page.getByRole('dialog')
    await expect(drawer).toContainText(scenario.label)
    await expect(drawer.getByRole('link', { name: scenario.action })).toHaveAttribute('href', '/?page=agent&sessionId=original-session')
    await expect(drawer.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
    await drawer.getByRole('link', { name: scenario.action }).click()
    await expect(page.getByTestId('agent-destination')).toHaveText('original-session')
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

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

test('recorded applications identify displayed materials as current versions', async ({ page }) => {
  const state = await install(page, { recordedInitially: true, stale: true })
  await open(page)
  await expect(page.getByText(/This application has a recorded result|此申请已有结果记录/).first()).toBeVisible()
  await expect(page.getByText(/materials shown below are their current versions.*cannot confirm they match|下方显示的是材料的当前版本.*无法确认它们与提交时的版本一致/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
  expect(state.writes).toEqual([])
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

test('a pending audit is not mistaken for no audit when saving a missing description', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Focused pending-audit regression')
  const state = await install(page, { descriptionMode: 'audit' })
  await page.route('**/api/jobs/outside-page/audit-application', route => route.fulfill({ json: { state: 'pending' } }))
  await open(page)
  await page.getByRole('button', { name: 'Add job description', exact: true }).click()
  const description = page.getByLabel('Job description', { exact: true })
  await description.fill('A description that must wait until the audit is resolved.')
  await page.getByRole('button', { name: 'Save description', exact: true }).click()
  await expect(page.getByText('An existing audit prevents adding a description here')).toBeVisible()
  await expect(description).toHaveValue('A description that must wait until the audit is resolved.')
  expect(state.writes).toEqual([])
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

for (const issueCase of ['letter', 'mixed'] as const) {
  test(`letter factual ${issueCase} repair opens current Resume without writes`, async ({ page }) => {
    const state = await install(page, { selectedLetter: true })
    const letterIssue = { area: 'cover_letter', severity: 'critical', resolution: 'contradiction', title: 'Incorrect letter claim', evidence: 'Not supported', action: 'Edit the letter' }
    const resumeIssue = { area: 'resume', severity: 'warning', resolution: 'contradiction', title: 'Incorrect resume claim', evidence: 'Not supported', action: 'Edit the resume' }
    state.audit = { ...state.audit, audit: { ...state.audit.audit, verdict: 'needs_review', findings: [letterIssue, ...(issueCase === 'mixed' ? [resumeIssue] : [])] } } as typeof state.audit
    await open(page)
    await page.getByRole('button', { name: /Review material issues|查看材料问题/, exact: true }).click()
    await expect(page.getByText(/open Cover Letter and verify the selected letter|打开求职信，核对当前选中的信/).first()).toBeVisible()
    await page.getByRole('button', { name: /Review the selected cover letter|核对已选求职信/, exact: true }).click()
    await expect(page).toHaveURL(/page=resume/)
    await expect(page).toHaveURL(/resumeId=resume-1/)
    await expect(page).toHaveURL(/returnJobId=outside-page/)
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('letter evidence guidance names the selected cover letter and opens the same application', async ({ page }) => {
  const state = await install(page, { selectedLetter: true })
  state.audit = { ...state.audit, audit: { ...state.audit.audit, verdict: 'needs_review', findings: [
    { area: 'cover_letter', severity: 'warning', resolution: 'evidence_needed', title: 'Letter evidence needed', evidence: 'No support', action: 'Review the letter' },
  ] } } as typeof state.audit
  await open(page)
  await page.getByRole('button', { name: /Provide missing information|补充信息/, exact: true }).click()
  const card = page.getByText('Letter evidence needed').locator('..')
  await card.getByRole('button', { name: /Review the selected cover letter|核对已选求职信/, exact: true }).click()
  await expect(page).toHaveURL(/page=resume/)
  await expect(page).toHaveURL(/returnJobId=outside-page/)
  expect(state.writes).toEqual([])
})

test('unavailable selected letter prevents factual repair navigation and writing', async ({ page }) => {
  const state = await install(page, { holdSelectedLetter: true })
  state.audit = { ...state.audit, coverLetterId: 'selected-letter', coverLetterUpdatedAt: time, audit: { ...state.audit.audit, verdict: 'needs_review', findings: [{ area: 'cover_letter', severity: 'critical', title: 'Incorrect letter claim', evidence: 'Not supported', action: 'Edit the letter' }] } } as typeof state.audit
  await open(page)
  await page.getByRole('button').filter({ has: page.getByText(/^(Cover letter|求职信)$/) }).click()
  state.releaseLetters()
  const unavailable = page.getByRole('status').filter({ hasText: /selected cover letter could not be loaded|无法加载已选求职信/i }).first()
  await expect(unavailable).toBeVisible()
  await unavailable.getByRole('button', { name: /Refresh status|刷新状态/ }).click()
  await expect(page).toHaveURL(/page=jobs/)
  expect(state.writes).toEqual([])
})

test('retry-only audit checks the existing selected materials without navigating', async ({ page }) => {
  const state = await install(page, { selectedLetter: true })
  state.audit = { ...state.audit, audit: { ...state.audit.audit, verdict: 'needs_review', findings: [{ area: 'job_match', severity: 'warning', title: 'Audit response needs retry', evidence: 'Retry needed', action: 'Retry' }] } } as typeof state.audit
  await open(page)
  await page.getByRole('button', { name: /Review material issues|查看材料问题/, exact: true }).click()
  await page.getByRole('button', { name: /Retry independent audit|重试独立审核/, exact: true }).click()
  await expect.poll(() => state.writes.some(write => write.path.endsWith('/audit-application'))).toBe(true)
  expect(state.writes.some(write => write.path.endsWith('/cover-letters/generate') || write.path.endsWith('/tailor-resume'))).toBe(false)
  await expect(page).toHaveURL(/page=jobs/)
})

test('Resume explains the replacement scope and backup limits before repair', async ({ page }) => {
  const state = await install(page, { auditCorrection: true })
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  await expect(page.getByRole('note').filter({ hasText: /replaces the entire affected resume section or cover letter|替换受影响的整段简历内容或整封求职信/ })).toBeVisible()
  expect(state.writes).toEqual([])
})

for (const repairError of ['unclear', 'too-many', 'conflict', 'other'] as const) {
  test(`resume repair ${repairError} failure keeps the application and explains the next step`, async ({ page }) => {
    const state = await install(page)
    state.audit = { ...state.audit, operationId: '123e4567-e89b-42d3-a456-426614174000', receipt: { version: 1, signature: 'a'.repeat(64) }, audit: { ...state.audit.audit, verdict: 'needs_review', findings: [{ area: 'resume', severity: 'warning', resolution: 'contradiction', title: 'Incorrect resume claim', evidence: 'Not supported', action: 'Edit the resume' }] } } as typeof state.audit
    const error = repairError === 'unclear' ? 'The affected resume section is unclear. Open the resume and edit it manually.'
      : repairError === 'too-many' ? 'Too many resume issues to correct at once. Open the resume and review them manually.'
        : repairError === 'conflict' ? 'The resume changed during correction. Refresh and review the latest version.' : 'Other fixture error'
    let attempts = 0
    await page.route('**/api/jobs/outside-page/tailor-resume', async route => { attempts++; await route.fulfill({ status: repairError === 'conflict' ? 409 : 422, json: { error } }) })
    await open(page)
    await page.getByRole('button', { name: /Review material issues|查看材料问题/, exact: true }).click()
    await expect(page.getByText(/entire affected resume section|受影响的整段简历内容/)).toBeVisible()
    await page.getByRole('button', { name: /Fix with AI and re-audit|使用 AI 修复并重新审核/, exact: true }).click()
    const expected = repairError === 'unclear' ? /affected section is unclear.*this application’s resume|无法确定受影响的简历章节.*此职位的简历/
      : repairError === 'too-many' ? /too many resume issues.*this application’s resume|需要修正的简历问题过多.*此职位的简历/
        : repairError === 'conflict' ? /resume changed during correction.*refresh|修正期间简历已发生变化.*刷新/i : /Other fixture error|请重试。/
    await expect(page.getByText(expected)).toBeVisible()
    expect(attempts).toBe(1)
    expect(state.writes.some(write => write.path.endsWith('/audit-application') || write.path.endsWith('/assign'))).toBe(false)
    await expect(page).toHaveURL(/page=jobs/)
  })
}

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


test('an unknown first audit keeps the generated resume without repeating preparation', async ({ page }) => {
  const state = await install(page, { firstPreparation: true, failFirstAudit: true })
  await open(page)
  const prepare = page.getByRole('button', { name: /Prepare application materials|准备申请材料|Check current materials|检查当前材料/, exact: true })
  await prepare.click()
  await expect.poll(() => state.writes.map(write => write.path)).toEqual([
    '/api/jobs/outside-page/tailor-resume', '/api/jobs/outside-page/audit-application',
  ])
  await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
  await expect(page.getByText(/This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i).first()).toBeVisible()
  expect(state.writes[1].body).toEqual({ resumeId: 'resume-1', coverLetterId: null })
  expect(state.job.finalResumeId).toBeNull()
  await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
  await expect(prepare).toBeDisabled()
  const status = page.getByRole('status').filter({ hasText: /This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i }).first()
  const refresh = status.getByRole('button', { name: /Refresh status|刷新状态/, exact: true })
  await expect(refresh).toBeEnabled()
  await refresh.click()
  await expect(status).toBeVisible()
  await expect(prepare).toBeDisabled()
  expect(state.writes.map(write => write.path)).toEqual(['/api/jobs/outside-page/tailor-resume', '/api/jobs/outside-page/audit-application'])
  expect(state.job.finalResumeId).toBeNull()
  await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
  expect(state.unexpected).toEqual([])
})

test('a certified no-write audit retry reuses the prepared resume', async ({ page }) => {
  const state = await install(page, { firstPreparation: true })
  let posts = 0
  await page.route('**/api/jobs/outside-page/audit-application', route => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts++
    if (posts > 1) return route.fallback()
    const attempt = route.request().headers()['x-application-audit-attempt-id']
    return route.fulfill({ status: 422, json: { error: AUDIT_LIMIT_MESSAGES.final_resume_too_long, code: 'AUDIT_PRECHECK_NOT_REGISTERED', auditRegistration: 'not_started', auditAttemptId: attempt } })
  })
  await open(page)
  const prepare = page.getByRole('button', { name: /Prepare application materials|准备申请材料|Check current materials|检查当前材料/, exact: true })
  await prepare.click()
  await expect.poll(() => posts).toBe(1)
  await expect(page.getByText(/selected resume is too long|所选简历内容过长/i).first()).toBeVisible()
  expect(state.writes.filter(write => write.path.endsWith('/tailor-resume'))).toHaveLength(1)
  expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('applymate:audit-fence:fixture-user:outside-page'))).toBeNull()
  await prepare.click()
  await expect.poll(() => posts).toBe(2)
  await expect.poll(() => state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(1)
  expect(state.writes.filter(write => write.path.endsWith('/tailor-resume'))).toHaveLength(1)
  expect(state.writes.find(write => write.path.endsWith('/assign'))?.body).toEqual({ finalResumeId: 'resume-1' })
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

for (const outcome of ['verified', 'unavailable'] as const) {
  test(`current audit receipt ${outcome} gates readiness after the resume version changes`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'Focused audit receipt regression')
    const state = await install(page, { stale: true })
    let releaseRead = () => {}
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    let readStarted = false
    await page.route('**/api/jobs/outside-page/audit-application', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { resumeId: string; coverLetterId: string | null }
        state.writes.push({ path: '/api/jobs/outside-page/audit-application', body })
        state.audit = {
          ...audit(state.resume.updatedAt),
          audit: { ...audit().audit, findings: [{ area: 'resume', severity: 'pass', title: 'Verified', evidence: 'Supported', action: 'None' }] },
        } as typeof state.audit
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...state.audit.audit, operationId: state.audit.operationId, resumeUpdatedAt: state.resume.updatedAt }) })
      }
      if (state.writes.some(write => write.path === '/api/jobs/outside-page/assign')) {
        readStarted = true
        await readGate
        return route.fulfill({ status: outcome === 'verified' ? 200 : 500, contentType: 'application/json', body: JSON.stringify(outcome === 'verified' ? state.audit : { error: 'Unavailable' }) })
      }
      return route.fallback()
    })
    try {
      await open(page)
      const prepare = page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
      await expect(prepare).toBeVisible()
      // The list still contains the older version; the preparation read gets this newer one.
      state.resume = { ...state.resume, updatedAt: '2026-10-30T12:00:00.000Z' }
      await prepare.click()
      await expect.poll(() => readStarted).toBe(true)
      await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
      releaseRead()
      if (outcome === 'verified') {
        await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toBeVisible()
      } else {
        await expect(page.getByText(/Preparation could not finish/)).toBeVisible()
        await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
      }
    } finally { releaseRead() }
  })
}

for (const receiptCase of ['verified', 'mismatch', 'unsigned', 'missing-operation', 'different-operation', 'missing-post-operation'] as const) test(`new review findings require the matching signed receipt before correction: ${receiptCase}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises application review receipt handoff')
  const state = await install(page, { stale: true })
  const signature = 'a'.repeat(64)
  const operationId = '123e4567-e89b-42d3-a456-426614174000'
  const findings = [{ area: 'resume', target: 'summary', severity: 'warning', resolution: 'contradiction', title: 'Incorrect summary claim', evidence: 'Not supported', action: 'Correct summary' }]
  const newAudit = { ...state.audit.audit, verdict: 'needs_review', summary: 'New review found an issue', findings }
  let reviewed = false, readsAfterReview = 0
  await page.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() === 'POST') {
      reviewed = true
      state.writes.push({ path: '/api/jobs/outside-page/audit-application', body: route.request().postDataJSON() })
      return route.fulfill({ json: { ...newAudit, resumeUpdatedAt: state.resume.updatedAt, ...(receiptCase === 'missing-post-operation' ? {} : { operationId }) } })
    }
    if (!reviewed) return route.fallback()
    readsAfterReview++
    const stored = { ...state.audit, resumeUpdatedAt: state.resume.updatedAt, audit: receiptCase === 'mismatch' ? { ...newAudit, summary: 'Different review result' } : newAudit,
      receipt: receiptCase === 'unsigned' ? undefined : { version: 1, signature }, operationId: receiptCase === 'missing-operation' ? undefined : receiptCase === 'different-operation' ? '123e4567-e89b-42d3-a456-426614174001' : operationId }
    return route.fulfill({ json: stored })
  })
  await open(page)
  const prepare = page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
  await expect(prepare).toBeVisible()
  await prepare.click()
  if (receiptCase !== 'missing-post-operation') await expect.poll(() => readsAfterReview, { timeout: 6000 }).toBeGreaterThan(0)
  if (receiptCase === 'verified') {
    await expect(page.getByText('New review found an issue')).toBeVisible()
    await page.getByRole('button', { name: /Fix with AI and re-audit|使用 AI 修复并重新审核/, exact: true }).click()
    await expect.poll(() => state.writes.find(write => write.path.endsWith('/tailor-resume'))).toMatchObject({ body: { resumeId: 'resume-1', forceRetailor: true, auditReceiptSignature: signature, auditOperationId: operationId } })
  } else {
    await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Fix with AI and re-audit|使用 AI 修复并重新审核/, exact: true })).toHaveCount(0)
    expect(state.writes.some(write => write.path.endsWith('/tailor-resume'))).toBe(false)
  }
  expect(state.unexpected).toEqual([])
})

for (const receiptCase of ['verified', 'different-operation', 'missing-post-operation'] as const) test(`passing review requires the same operation after confirmation: ${receiptCase}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises application review operation handoff')
  const state = await install(page, { stale: true })
  let reviewed = false
  await page.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() === 'POST') {
      reviewed = true
      const body = route.request().postDataJSON()
      state.writes.push({ path: '/api/jobs/outside-page/audit-application', body })
      state.audit = audit(state.resume.updatedAt)
      return route.fulfill({ json: { ...state.audit.audit, resumeUpdatedAt: state.resume.updatedAt, ...(receiptCase === 'missing-post-operation' ? {} : { operationId: fixtureAuditOperation }) } })
    }
    if (!reviewed) return route.fallback()
    return route.fulfill({ json: { ...state.audit, receipt: { version: 1, signature: 'a'.repeat(64) }, operationId: receiptCase === 'different-operation' ? '123e4567-e89b-42d3-a456-426614174001' : fixtureAuditOperation } })
  })
  await open(page)
  await page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true }).click()
  if (receiptCase === 'verified') await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toBeVisible()
  else {
    await expect(page.getByText(/Preparation could not finish|准备未完成/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
  }
  expect(state.unexpected).toEqual([])
})

test('an old completed review without an operation ID cannot establish readiness', async ({ page }, testInfo) => {
  const state = await install(page)
  await page.route('**/api/jobs/outside-page/audit-application', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { ...state.audit, operationId: undefined, receipt: { version: 1, signature: 'a'.repeat(64) } } })
    : route.fallback())
  await open(page)
  await expect(page.getByRole('status').filter({ hasText: /review status|审核状态/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('a newly failed audit cannot reuse an older passing receipt for the same version', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Focused audit receipt regression')
  const state = await install(page, { stale: true })
  state.audit = { ...state.audit, audit: { ...state.audit.audit, findings: [{ area: 'resume', severity: 'pass', title: 'Verified', evidence: 'Supported', action: 'None' }] } } as typeof state.audit
  await page.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON()
    state.writes.push({ path: '/api/jobs/outside-page/audit-application', body })
    state.audit = { ...state.audit, operationId: '123e4567-e89b-42d3-a456-426614174001', receipt: { version: 1, signature: 'b'.repeat(64) }, resumeUpdatedAt: state.resume.updatedAt, audit: { ...state.audit.audit, verdict: 'needs_review', summary: 'New audit found an issue', findings: [{ area: 'resume', severity: 'warning', title: 'Verify this', evidence: 'Missing support', action: 'Review' }] } }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...state.audit.audit, operationId: state.audit.operationId, resumeUpdatedAt: state.resume.updatedAt }) })
  })
  await open(page)
  const prepare = page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
  await expect(prepare).toBeVisible()
  // Make the subsequent preparation read match the old passing receipt.
  state.resume = { ...state.resume, updatedAt: state.audit.resumeUpdatedAt }
  await prepare.click()
  await expect(page.getByText('New audit found an issue')).toBeVisible()
  await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
})

test('an older audit read cannot overwrite another tab’s newer audit', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Focused audit concurrency regression')
  const state = await install(page)
  state.audit = { ...state.audit, audit: { ...state.audit.audit, findings: [{ area: 'resume', severity: 'pass', title: 'Verified', evidence: 'Supported', action: 'None' }] } } as typeof state.audit
  await open(page)
  const download = page.getByRole('button', { name: /Download application materials|下载申请材料/ })
  await expect(download).toBeVisible()
  let releaseOld = () => {}
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
  let reads = 0
  await page.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    const read = ++reads
    const snapshot = structuredClone(state.audit)
    if (read === 1) await oldGate
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) })
  })
  const other = await context.newPage()
  await other.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    state.audit = { ...state.audit, audit: { ...state.audit.audit, verdict: 'needs_review', summary: 'Newer audit', findings: [{ area: 'resume', severity: 'warning', title: 'Verify this', evidence: 'Missing support', action: 'Review' }] } } as typeof state.audit
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.audit.audit) })
  })
  try {
    await other.goto(`${origin}/?page=fixture-other`)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => reads).toBe(1)
    await expect(download).toHaveCount(0)
    expect(await other.evaluate(async () => (await fetch('/api/jobs/outside-page/audit-application', { method: 'POST' })).status)).toBe(200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => reads).toBe(2)
    await expect(page.getByText('Correct factual issues before applying')).toBeVisible()
    await expect(download).toHaveCount(0)
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/audit-application') && response.request().method() === 'GET')
    releaseOld()
    await (await oldResponse).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByText('Correct factual issues before applying')).toBeVisible()
    await expect(download).toHaveCount(0)
  } finally { releaseOld(); await other.close() }
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
        const missingVersion = scenario.version === 'resume-missing' || scenario.version === 'letter-missing'
        if (missingVersion) await expect(page.getByText(/audit response does not identify the prepared material versions.*do not start another review|审核响应未能确认所准备的材料版本.*请勿再次发起审核/i).first()).toBeVisible()
        else await expect(page.getByText(/audit could not be matched to the prepared material versions|无法确认审核所用版本与准备的材料一致/i).first()).toBeVisible()
        expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
        await expect(page.getByText(/Application materials are ready|申请材料已准备好/, { exact: true })).toHaveCount(0)
        if (missingVersion) {
          await expect(page.getByText(/This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i).first()).toBeVisible()
          await expect.poll(() => page.evaluate(() => sessionStorage.getItem('applymate:audit-fence:fixture-user:outside-page'))).not.toBeNull()
          const retry = page.getByRole('button', { name: /Check current materials|检查当前材料/, exact: true })
          await expect(retry).toBeDisabled()
          const status = page.getByRole('status').filter({ hasText: /This tab has an unconfirmed review request|此标签页有一项尚未确认的审核请求/i }).first()
          const refresh = status.getByRole('button', { name: /Refresh status|刷新状态/, exact: true })
          await expect(refresh).toBeEnabled()
          await refresh.click()
          await expect(status).toBeVisible()
          await expect(retry).toBeDisabled()
          await expect(page.getByRole('button', { name: /Download application materials|下载申请材料/ })).toHaveCount(0)
          expect(state.writes.filter(write => write.path.endsWith('/assign'))).toHaveLength(0)
        }
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


// This fixture asserts browser delivery of a synthetic server response; it does not
// claim that a real server produced a ZIP, a signed audit, or a PDF.
async function expectApplicationZip(page: Page) {
  const downloadButton = page.getByRole('button', { name: /Download application materials|下载申请材料/ })
  await expect(downloadButton).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await downloadButton.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  const file = await download.path()
  expect(file).toBeTruthy()
  expect((await readFile(file!)).toString()).toBe('synthetic server ZIP response')
}

for (const selectedLetter of [false, true]) {
  test(`downloads the mocked application response with ${selectedLetter ? 'selected letter' : 'resume only'}`, async ({ page }) => {
    const state = await install(page, { selectedLetter })
    await open(page)
    await expectApplicationZip(page)
    expect(state.packRequests).toBe(1)
    expect(state.writes).toEqual([])
    expect(state.unexpected).toEqual([])
  })
}

test('download failure from the server is not reported as a successful download', async ({ page }) => {
  const state = await install(page)
  await page.route('**/api/jobs/outside-page/application-pack', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Use print view for unsupported characters.' }) }))
  await open(page)
  const downloads: string[] = []
  page.on('download', item => downloads.push(item.suggestedFilename()))
  await page.getByRole('button', { name: /Download application materials|下载申请材料/ }).click()
  await expect(page.getByText(/Some characters cannot be included in the PDF|PDF 暂不支持部分字符/)).toBeVisible()
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
  await expectApplicationZip(page)
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


test('application material details have one keyboard-operated expandable control', async ({ page }, testInfo) => {
  const state = await install(page, { auditCorrection: true })
  await open(page)
  const drawer = page.getByRole('dialog')
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  const titles = chinese ? ['简历', '求职信', '独立审核'] : ['Resume', 'Cover letter', 'Independent audit']
  for (const title of titles) {
    const toggle = drawer.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
    await expect(toggle).toHaveCount(1)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const panelId = await toggle.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    const panel = drawer.locator(`[id="${panelId}"]`)
    await expect(panel).toBeHidden()
    let reached = false
    for (let index = 0; index < 120; index++) {
      await page.keyboard.press('Tab')
      if (await toggle.evaluate(element => document.activeElement === element)) { reached = true; break }
    }
    expect(reached).toBe(true)
    await page.keyboard.press('Enter')
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(panel).toBeVisible()
    if (title === 'Independent audit' || title === '独立审核') await expect(panel).toContainText('Fix summary')
    await page.keyboard.press('Space')
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toBeHidden()
  }
  await expect(drawer.getByRole('button', { name: /^Show .* details$/ })).toHaveCount(0)
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('mobile keyboard opens an application, reviews its issue and returns focus to its card', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'Exercises the narrow application list with a keyboard')
  const state = await install(page, { descriptionMode: 'two', auditCorrection: true })
  await page.goto(`${origin}/?page=jobs`)
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  const entry = page.getByRole('button', { name: `${chinese ? '查看此申请' : 'View this application'}: Fixture Employer · Application flow engineer`, exact: true })
  await expect(entry).toBeVisible()
  await expect(page.locator('.jobs-mobile-list').getByRole('checkbox', { name: `${chinese ? '选择职位' : 'Select job'}: Fixture Employer · Application flow engineer`, exact: true })).toBeVisible()
  let reachedEntry = false
  for (let index = 0; index < 120; index++) {
    await page.keyboard.press('Tab')
    if (await entry.evaluate(element => document.activeElement === element)) { reachedEntry = true; break }
  }
  expect(reachedEntry).toBe(true)
  await page.keyboard.press('Enter')
  const drawer = page.getByRole('dialog')
  await expect(drawer).toContainText('Application flow engineer')
  await expect(drawer).toContainText('Fixture Employer')
  await expect(page).toHaveURL(/highlight=outside-page/)
  const review = drawer.getByRole('button', { name: /Review material issues|查看材料问题/, exact: true })
  await expect(review).toBeVisible()
  let reachedReview = false
  for (let index = 0; index < 120; index++) {
    await page.keyboard.press('Tab')
    if (await review.evaluate(element => document.activeElement === element)) { reachedReview = true; break }
  }
  expect(reachedReview).toBe(true)
  await page.keyboard.press('Enter')
  await expect(drawer.getByText('Fix summary')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(entry).toBeFocused()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('desktop job selection names its company and role in the current language', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop-'), 'Exercises desktop application selection')
  const state = await install(page, { descriptionMode: 'two' })
  await page.goto(`${origin}/?page=jobs`)
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  await expect(page.getByRole('table').getByRole('checkbox', { name: `${chinese ? '选择职位' : 'Select job'}: Fixture Employer · Application flow engineer`, exact: true })).toBeVisible()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('desktop job sorting works by keyboard and retains focus', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop-'), 'Exercises desktop application sorting')
  const state = await install(page, { descriptionMode: 'two' })
  await page.goto(`${origin}/?page=jobs`)
  const table = page.getByRole('table')
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  const header = table.getByRole('columnheader', { name: chinese ? '公司' : 'Company', exact: true })
  const button = header.getByRole('button', { name: chinese ? '公司' : 'Company', exact: true })
  await expect(button).toBeVisible()
  let reachedSort = false
  for (let index = 0; index < 120; index++) {
    await page.keyboard.press('Tab')
    if (await button.evaluate(element => document.activeElement === element)) { reachedSort = true; break }
  }
  expect(reachedSort).toBe(true)
  await page.keyboard.press('Enter')
  await expect(header).toHaveAttribute('aria-sort', 'descending')
  await expect(table.locator('tbody tr').first()).toContainText('Second Employer')
  await expect(button).toBeFocused()
  await page.keyboard.press('Space')
  await expect(header).toHaveAttribute('aria-sort', 'ascending')
  await expect(table.locator('tbody tr').first()).toContainText('Fixture Employer')
  await expect(button).toBeFocused()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('current-page sort stays consistent across controls, application return and reload', async ({ page }, testInfo) => {
  const state = await install(page, { descriptionMode: 'two' })
  await page.goto(`${origin}/?page=jobs`)
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  const mobile = testInfo.project.name.startsWith('mobile-')
  const sortLabel = chinese ? '当前页排序：' : 'Sort current page:'
  const select = page.getByRole('combobox', { name: sortLabel })
  const rows = mobile ? page.locator('.jobs-mobile-list article') : page.locator('table tbody tr')
  await expect(select).toBeVisible()
  await select.selectOption('company')
  await expect(rows.first()).toContainText('Second Employer')
  if (!mobile) await expect(page.getByRole('columnheader', { name: chinese ? '公司' : 'Company', exact: true })).toHaveAttribute('aria-sort', 'descending')
  await page.getByRole('button', { name: chinese ? '排序方向：降序；切换为升序' : 'Sort direction: descending; change to ascending' }).click()
  await expect(rows.first()).toContainText('Fixture Employer')
  await expect(page).toHaveURL(/jobsSort=company/)
  await expect(page).toHaveURL(/jobsDirection=asc/)
  if (!mobile) await expect(page.getByRole('columnheader', { name: chinese ? '公司' : 'Company', exact: true })).toHaveAttribute('aria-sort', 'ascending')
  if (mobile) {
    await rows.first().getByRole('button', { name: /Fixture Employer.*Application flow engineer/ }).click()
  } else {
    await rows.first().getByRole('button', { name: chinese ? '查看此申请' : 'View this application' }).click()
  }
  const drawer = page.getByRole('dialog')
  await expect(drawer).toContainText('Fixture Employer')
  await drawer.getByRole('button', { name: /Close application details|关闭申请详情/ }).click()
  await expect(rows.first()).toContainText('Fixture Employer')
  await page.reload()
  await expect(select).toHaveValue('company')
  await expect(rows.first()).toContainText('Fixture Employer')
  await expect(page.getByRole('button', { name: chinese ? '排序方向：升序；切换为降序' : 'Sort direction: ascending; change to descending' })).toBeVisible()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('current-page date, score and role sorting use the selected direction', async ({ page }, testInfo) => {
  const state = await install(page, { descriptionMode: 'two' })
  await page.route('**/api/jobs?*', route => route.fulfill({ json: {
    jobs: [state.job, { ...state.job, id: 'job-2', company: 'Second Employer', role: 'Second fixture role', score: 12, createdAt: '2026-10-29T10:00:00.000Z' }],
    total: 80, statusCounts: { saved: 80, applied: 0, interview: 0, offer: 0, rejected: 0 },
  } }))
  await page.goto(`${origin}/?page=jobs`)
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  const rows = testInfo.project.name.startsWith('mobile-') ? page.locator('.jobs-mobile-list article') : page.locator('table tbody tr')
  const select = page.getByRole('combobox', { name: chinese ? '当前页排序：' : 'Sort current page:' })
  const descending = () => page.getByRole('button', { name: chinese ? '排序方向：降序；切换为升序' : 'Sort direction: descending; change to ascending' })
  const ascending = () => page.getByRole('button', { name: chinese ? '排序方向：升序；切换为降序' : 'Sort direction: ascending; change to descending' })
  await expect(rows.first()).toContainText('Fixture Employer')
  await descending().click()
  await expect(rows.first()).toContainText('Second Employer')
  await select.selectOption('score')
  await expect(rows.first()).toContainText('Second Employer')
  await ascending().click()
  await expect(rows.first()).toContainText('Fixture Employer')
  await select.selectOption('role')
  await expect(rows.first()).toContainText('Second Employer')
  if (!testInfo.project.name.startsWith('mobile-')) await expect(page.getByRole('columnheader', { name: chinese ? '职位' : 'Role', exact: true })).toHaveAttribute('aria-sort', 'descending')
  await descending().click()
  await expect(rows.first()).toContainText('Fixture Employer')
  if (!testInfo.project.name.startsWith('mobile-')) await expect(page.getByRole('columnheader', { name: chinese ? '职位' : 'Role', exact: true })).toHaveAttribute('aria-sort', 'ascending')
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

test('newly added application remains in the current sort order', async ({ page }, testInfo) => {
  const state = await install(page, { descriptionMode: 'two' })
  await page.goto(`${origin}/?page=jobs`)
  const chinese = testInfo.project.metadata.appLocale === 'zh'
  const rows = testInfo.project.name.startsWith('mobile-') ? page.locator('.jobs-mobile-list article') : page.locator('table tbody tr')
  await page.getByRole('combobox', { name: chinese ? '当前页排序：' : 'Sort current page:' }).selectOption('company')
  await page.getByRole('button', { name: chinese ? '排序方向：降序；切换为升序' : 'Sort direction: descending; change to ascending' }).click()
  await page.getByRole('button', { name: chinese ? '+ 添加职位' : '+ Add Job', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(chinese ? '公司 *' : 'Company *', { exact: true }).fill('Zulu Employer')
  await dialog.getByLabel(chinese ? '职位 *' : 'Role *', { exact: true }).fill('New fixture role')
  await dialog.getByRole('button', { name: chinese ? '添加职位' : 'Add Job', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(rows).toHaveCount(3)
  await expect(rows.first()).toContainText('Fixture Employer')
  await expect(rows.last()).toContainText('Zulu Employer')
  expect(state.writes.filter(item => item.path === '/api/jobs')).toHaveLength(1)
  expect(state.unexpected).toEqual([])
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


for (const taskState of ['updated', 'delayed'] as const) test(`answered question remains in its session while application task state is ${taskState}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the real desktop Agent shell')
  const state = await install(page, { realAgent: true, twoJobQuestions: true, delayedQuestionTask: taskState === 'delayed' })
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  await expect(page.getByRole('dialog')).toContainText('Application flow engineer')
  await page.getByRole('link', { name: 'Continue in the original task' }).click()
  await expect(page).toHaveURL(/sessionId=session-a/)
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  const first = page.locator('[data-agent-question-card="true"]')
  await expect(first).toContainText('Confirm the same fixture fact?')
  await first.getByRole('button', { name: 'Yes', exact: true }).click()
  await first.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect.poll(() => state.answeredJobA).toBe(true)
  const readsBeforeReturn = state.taskReads
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=outside-page`)
  const application = page.getByRole('dialog')
  await expect(application).toContainText('Application flow engineer')
  await expect.poll(() => state.taskReads).toBeGreaterThan(readsBeforeReturn)
  const task = application.getByRole('region', { name: 'Fixture Employer · Application flow engineer' })
  await expect(task).toContainText(taskState === 'delayed' ? 'Your action is needed' : 'Filling application')
  const taskLink = task.getByRole('link', { name: taskState === 'delayed' ? 'Continue in the original task' : 'View task activity' })
  await expect(taskLink).toBeVisible()
  const timelineResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent/sessions/session-a/timeline' && response.request().method() === 'GET')
  await taskLink.click()
  await expect(page).toHaveURL(/sessionId=session-a/)
  const timeline = await (await timelineResponse).json()
  expect(timeline.items).toEqual([expect.objectContaining({ id: 'item-question-a', sessionId: 'session-a', turnId: 'turn-a', status: 'completed', content: expect.objectContaining({ questionId: 'question-a', answerAvailable: true, pending: false }) })])
  await page.getByRole('button', { name: /^Tasks & results/ }).click()
  const history = page.locator('[data-agent-question-history="true"]')
  await expect(history).toBeVisible()
  await history.locator('summary').click()
  await expect(history).toContainText('Confirm the same fixture fact?')
  await expect(history.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0)
  await expect(history.getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-agent-question-card="true"]').getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0)
  await page.goto(`${origin}/?shell=1&page=jobs&highlight=job-2`)
  await expect(page.getByRole('dialog')).toContainText('Employer B')
  await page.getByRole('link', { name: 'Continue in the original task' }).click()
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
  await page.getByRole('link', { name: 'Continue in the original task' }).click()
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
  await expect(taskCard).not.toContainText('Your action is needed')
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
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('unknown')
  await expect(page.getByRole('button', { name: /Record that I submitted|记录我已在雇主网站提交/ })).toHaveCount(0)
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
  await page.clock.install()
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
    await expect.poll(() => posts).toBe(1)
    await expect(refresh).toBeDisabled()
    expect(await page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('pending')
    await page.clock.fastForward(15_001)
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
  await page.clock.install()
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
    await expect(refresh).toBeDisabled()
    expect(await page.evaluate(() => sessionStorage.getItem('applymate:manual-record:fixture-user:outside-page'))).toBe('unknown')
    await page.clock.fastForward(15_001)
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
    await expect(page.getByRole('button', { name: /^(Refresh task status|刷新任务状态)$/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Refresh record status|刷新记录状态/ })).toHaveCount(1)
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

test('late confirmed Resume review reconciles after its deadline', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises the same-tab review deadline')
  await page.clock.install()
  const state = await install(page)
  let release = () => {}, posts = 0, registered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const reviewed = { ...state.audit, operationId: '123e4567-e89b-42d3-a456-426614174001', audit: { ...state.audit.audit, summary: 'Late confirmed review' } }
  await page.route('**/api/jobs/outside-page/audit-application', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: registered ? reviewed : state.audit })
    posts++
    await gate
    registered = true
    return route.fulfill({ json: { ...reviewed.audit, operationId: reviewed.operationId, resumeUpdatedAt: reviewed.resumeUpdatedAt } })
  })
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await page.getByRole('button', { name: /Run independent audit|Run audit again/ }).click()
    await expect.poll(() => posts).toBe(1)
    await page.clock.fastForward(30_001)
    await expect(page.getByText('This tab has an unconfirmed review request', { exact: false }).first()).toBeVisible()
    release()
    await expect(page.getByText('Late confirmed review', { exact: false }).first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('applymate:audit-fence:fixture-user:outside-page'))).toBeNull()
    expect(posts).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally { release() }
})

for (const result of ['matching', 'different-operation'] as const) test(`Resume correction requires matching new review operation: ${result}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop correction controls')
  const state = await install(page, { auditCorrection: true })
  const initialOperation = state.audit.operationId
  const nextOperation = '123e4567-e89b-42d3-a456-426614174002'
  const otherOperation = '123e4567-e89b-42d3-a456-426614174003'
  const original = state.audit.audit.findings[0]
  state.audit = { ...state.audit, audit: { ...state.audit.audit, findings: [original, { ...original, target: 'summary', title: 'Second fix', proposedValue: 'Next summary' }] } }
  let corrected = false
  const requests: Array<{ auditOperationId: string; findingIndex: number }> = []
  await page.route('**/api/jobs/outside-page/audit-application', route => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ json: corrected && result === 'different-operation' ? { ...state.audit, operationId: otherOperation } : state.audit })
  })
  await page.route('**/api/jobs/outside-page/audit-application/apply', route => {
    requests.push(route.request().postDataJSON())
    if (requests.length > 1) return route.abort('failed')
    const updatedAt = '2026-10-30T12:00:00.000Z'
    state.resume = { ...state.resume, updatedAt, content: { ...state.resume.content, summary: 'Audited v2 summary' } }
    state.audit = { ...state.audit, operationId: nextOperation, resumeUpdatedAt: updatedAt, audit: { ...state.audit.audit, findings: [{ ...original, applied: true }, state.audit.audit.findings[1]] } }
    corrected = true
    return route.fulfill({ json: { audit: state.audit.audit, operationId: nextOperation, target: 'summary', appliedContent: 'Audited v2 summary', resume: state.resume, coverLetter: null, resumeUpdatedAt: updatedAt } })
  })
  await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
  await page.getByRole('button', { name: 'Apply generated fix', exact: true }).first().click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0].auditOperationId).toBe(initialOperation)
  if (result === 'matching') {
    await expect(page.getByText('Second fix', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Apply generated fix', exact: true }).last().click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1].auditOperationId).toBe(nextOperation)
  } else {
    await expect(page.getByText('This tab has an unconfirmed review request', { exact: false }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Apply generated fix', exact: true })).toHaveCount(0)
    expect(requests.length).toBe(1)
  }
  expect(state.unexpected).toEqual([])
})

for (const proof of ['matching', 'wrong-attempt', 'late-matching'] as const) test(`Resume safely handles a correction no-write certificate: ${proof}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-en', 'Exercises desktop correction recovery')
  if (proof === 'late-matching') await page.clock.install()
  const state = await install(page, { auditCorrection: true })
  const nextOperation = '123e4567-e89b-42d3-a456-426614174002'
  let release = () => {}, posts = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/jobs/outside-page/audit-application/apply', async route => {
    posts++
    if (posts > 1) return route.abort('failed')
    const attempt = route.request().headers()['x-application-audit-attempt-id']
    state.audit = { ...state.audit, operationId: nextOperation, audit: { ...state.audit.audit, findings: [{ ...state.audit.audit.findings[0], title: 'Updated review finding' }] } }
    if (proof === 'late-matching') await gate
    return route.fulfill({ status: 409, json: { error: 'Review changed', code: 'AUDIT_CORRECTION_NOT_STARTED', correctionWrite: 'not_started', auditAttemptId: proof === 'wrong-attempt' ? '123e4567-e89b-42d3-a456-426614174009' : attempt } })
  })
  try {
    await page.goto(`${origin}/?page=resume&resumeId=resume-1&returnToJobs=1&returnJobId=outside-page`)
    await page.getByRole('button', { name: 'Apply generated fix', exact: true }).click()
    await expect.poll(() => posts).toBe(1)
    if (proof === 'late-matching') {
      await page.clock.fastForward(30_001)
      await expect(page.getByText(/The correction result is unconfirmed/)).toBeVisible()
      release()
    }
    const marker = () => page.evaluate(() => sessionStorage.getItem('applymate:audit-fence:fixture-user:outside-page'))
    if (proof === 'wrong-attempt') {
      await expect(page.getByText('This tab has an unconfirmed review request', { exact: false }).first()).toBeVisible()
      await expect.poll(marker).not.toBeNull()
      await expect(page.getByRole('button', { name: 'Apply generated fix', exact: true })).toHaveCount(0)
      expect(posts).toBe(1)
    } else {
      await expect(page.getByText('The review changed before this correction started', { exact: false }).first()).toBeVisible()
      await expect.poll(marker).toBeNull()
      await expect(page.getByText('Updated review finding', { exact: false }).first()).toBeVisible()
      expect(posts).toBe(1)
      await page.getByRole('button', { name: 'Apply generated fix', exact: true }).click()
      await expect.poll(() => posts).toBe(2)
    }
    expect(state.unexpected).toEqual([])
  } finally { release() }
})
