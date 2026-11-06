import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_LIMIT_MESSAGES } from '@/lib/application-audit-limits'

// Refuse all but an explicitly opted-in, separately named loopback database.
// Tables live in a random schema; no migrations or production data are touched.
const testUrl = process.env.APPLICATION_AUDIT_PG_TEST_URL
const disposable = process.env.APPLICATION_AUDIT_PG_TEST_DISPOSABLE
const enabled = Boolean(testUrl || disposable)
if (enabled) {
  let parsed: URL
  try { parsed = new URL(testUrl ?? '') } catch { throw new Error('Invalid disposable application-audit database') }
  if (disposable !== 'true' || !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/applymate_application_audit_test'
    || !parsed.username || parsed.search || parsed.hash || process.env.RLS_RUNTIME_MODE !== 'off') {
    throw new Error('Application-audit integration requires the explicitly marked disposable loopback database with RLS off')
  }
}

type LockEvidence = { pid?: number; startedAt?: Date; started: () => void; issued: () => void; beforeQuery?: Promise<void>; rawErrors?: unknown[] }
type RequestScope = { client: PrismaClient; userId: string; summary?: string; gate?: ReturnType<typeof gate>; repair?: boolean; review?: boolean; tailor?: boolean; tailorModelDone?: boolean; updateGate?: ReturnType<typeof gate>; proposedValue?: string; letterId?: string; auditOperationId?: string; auditAttemptId?: string; evidence?: LockEvidence }
const requestScope = new AsyncLocalStorage<RequestScope>()
function current(): RequestScope {
  const scope = requestScope.getStore()
  if (!scope) throw new Error('Missing application-audit test request scope')
  return scope
}
function gate() {
  let entered = () => {}
  let release = () => {}
  const reached = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { reached, waiting, entered: () => entered(), release: () => release() }
}
async function within<T>(value: Promise<T>, ms = 10_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([value, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Application-audit test timed out')), ms) })]) }
  finally { if (timeout) clearTimeout(timeout) }
}

const integration = enabled ? describe : describe.skip
integration('application audit ordering with disposable PostgreSQL', () => {
  const schema = `application_audit_${randomBytes(12).toString('hex')}`
  let admin: PrismaClient
  let clientA: PrismaClient
  let clientB: PrismaClient
  let schemaCreated = false
  let postAudit: typeof import('./route').POST
  let getAudit: typeof import('./route').GET
  let getPack: typeof import('../application-pack/route').GET
  let postPack: typeof import('../application-pack/route').POST
  let postRepair: typeof import('./apply/route').POST
  let postTailor: typeof import('../tailor-resume/route').POST
  let signedAuditActivityText: typeof import('@/lib/application-audit-receipt').signedAuditActivityText
  let registerAuditOperation: typeof import('@/lib/application-audit-operation').registerAuditOperation

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: testUrl! } } })
    await admin.$connect()
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    const schemaUrl = new URL(testUrl!)
    schemaUrl.searchParams.set('schema', schema)
    clientA = new PrismaClient({ datasources: { db: { url: schemaUrl.toString() } } })
    clientB = new PrismaClient({ datasources: { db: { url: schemaUrl.toString() } } })
    await clientA.$connect()
    await clientB.$connect()
    await clientA.$executeRawUnsafe(`CREATE TYPE "${schema}"."JobStatus" AS ENUM ('saved', 'applied', 'interview', 'offer', 'rejected')`)
    await clientA.$executeRawUnsafe(`CREATE TYPE "${schema}"."JobWorkflowState" AS ENUM ('draft', 'ready_to_apply', 'queued', 'submitting', 'submitted')`)
    await clientA.$executeRawUnsafe(`CREATE TYPE "${schema}"."ActivityType" AS ENUM ('agent_action', 'resume_tailored')`)
    await clientA.$executeRawUnsafe(`CREATE TABLE "${schema}"."Job" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "company" TEXT NOT NULL, "logo" TEXT, "role" TEXT NOT NULL,
      "location" TEXT, "status" "${schema}"."JobStatus" NOT NULL DEFAULT 'saved', "score" INTEGER, "url" TEXT,
      "description" TEXT, "salary" TEXT, "source" TEXT, "notes" TEXT, "coverLetter" TEXT, "analysisNote" TEXT,
      "keywords" TEXT, "appliedAt" TIMESTAMP(3), "followUpAt" TIMESTAMP(3),
      "workflowState" "${schema}"."JobWorkflowState" NOT NULL DEFAULT 'draft',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finalResumeId" TEXT, "finalCoverLetterId" TEXT
    )`)
    await clientA.$executeRawUnsafe(`CREATE TABLE "${schema}"."Resume" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "content" JSONB NOT NULL,
      "templateId" TEXT, "templateOptions" JSONB, "isDefault" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "directionId" TEXT, "kind" TEXT NOT NULL DEFAULT 'base', "parentResumeId" TEXT, "targetJobId" TEXT,
      "origin" TEXT NOT NULL DEFAULT 'manual', "basicsDetached" BOOLEAN NOT NULL DEFAULT false
    )`)
    await clientA.$executeRawUnsafe(`CREATE TABLE "${schema}"."ResumeVersion" (
      "id" TEXT PRIMARY KEY, "resumeId" TEXT NOT NULL, "userId" TEXT NOT NULL, "content" JSONB NOT NULL,
      "name" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await clientA.$executeRawUnsafe(`CREATE TABLE "${schema}"."CoverLetter" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "jobId" TEXT NOT NULL, "resumeId" TEXT, "content" TEXT NOT NULL,
      "tone" TEXT NOT NULL DEFAULT 'professional', "templateId" TEXT, "templateOptions" JSONB,
      "origin" TEXT NOT NULL DEFAULT 'manual', "isFinal" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await clientA.$executeRawUnsafe(`CREATE TABLE "${schema}"."Activity" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "jobId" TEXT, "type" "${schema}"."ActivityType" NOT NULL,
      "text" TEXT NOT NULL, "color" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    vi.doMock('@/lib/api-helpers', () => ({
      requireAuth: async () => ({ userId: current().userId }),
      prepareAiRoute: async () => ({ userId: current().userId, cfg: { provider: 'fixture', model: 'fixture' } }),
      isErrorResponse: (value: unknown) => value instanceof Response,
      ok: (value: unknown, status = 200) => Response.json(value, { status }),
      err: (message: string, status = 400) => Response.json({ error: message }, { status }),
    }))
    vi.doMock('@/lib/db', () => ({ db: new Proxy({}, { get(_target, key) {
      if (key === 'agentRole') return { findFirst: async () => null }
      if (key === '$transaction') return (callback: (tx: unknown) => Promise<unknown>) => {
        const request = current()
        const { client } = request
        const evidence = request.tailor && !request.tailorModelDone ? undefined : request.evidence
        return client.$transaction(async tx => {
          if (!evidence && !request.updateGate) return callback(tx)
          if (evidence) {
            const rows = await tx.$queryRaw<Array<{ pid: number; startedAt: Date }>>`SELECT pg_backend_pid() AS pid, transaction_timestamp() AS "startedAt"`
            evidence.pid = rows[0].pid
            evidence.startedAt = rows[0].startedAt
            evidence.started()
          }
          let first = true
          const observed = new Proxy(tx, { get(target, property, receiver) {
            if (property === 'resume' && request.tailorModelDone && request.updateGate) return new Proxy(target.resume, { get(delegate, key, delegateReceiver) {
              if (key === 'updateMany') return async (...args: unknown[]) => { request.updateGate!.entered(); await request.updateGate!.waiting; return Reflect.apply(delegate.updateMany, delegate, args) }
              return Reflect.get(delegate, key, delegateReceiver)
            } })
            if (property === '$queryRaw' && evidence) return async (...args: unknown[]) => {
              if (first) {
                first = false
                await evidence.beforeQuery
                const query = Promise.resolve(Reflect.apply(target.$queryRaw, target, args))
                evidence.issued()
                try { return await query } catch (error) { evidence.rawErrors?.push(error); throw error }
              }
              try { return await Reflect.apply(target.$queryRaw, target, args) } catch (error) { evidence.rawErrors?.push(error); throw error }
            }
            return Reflect.get(target, property, receiver)
          } })
          return callback(observed)
        }, { timeout: 15_000 })
      }
      const client = current().client
      const value = Reflect.get(client, key)
      return typeof value === 'function' ? value.bind(client) : value
    } }) }))
    vi.doMock('@/lib/auth-secret', () => ({ getAuthJwtSecret: () => 'disposable-audit-fixture-secret-32-bytes' }))
    vi.doMock('@/lib/persona', () => ({ buildPersona: async () => 'Synthetic confirmed fixture facts' }))
    vi.doMock('@/lib/persona-evidence', () => ({ personaEvidenceContext: async () => 'Synthetic fixture evidence' }))
    vi.doMock('@/lib/entitlements', () => ({ hasEffectiveEntitlement: async () => true }))
    vi.doMock('@/lib/agent/policy/legacy', () => ({ requireLegacyPolicy: () => undefined }))
    vi.doMock('@/lib/agent/role-config', () => ({ roleAiConfig: (_role: string, _row: unknown, cfg: unknown) => cfg }))
    vi.doMock('@/lib/model-router', () => ({
      modelChat: async () => {
        const request = current()
        request.gate?.entered()
        await request.gate?.waiting
        if (request.repair) return { provider: 'fixture', model: 'fixture', text: JSON.stringify({ proposedValue: 'Synthetic corrected summary' }) }
        if (request.tailor) { request.tailorModelDone = true; return { provider: 'fixture', model: 'fixture', text: JSON.stringify({ after: 'Synthetic corrected summary', reason: 'Fixture correction' }) } }
        return { provider: 'fixture', model: 'fixture', text: JSON.stringify({
          summary: request.summary ?? 'Fixture audit', matchScore: 80,
          findings: [request.review
            ? { area: 'resume', severity: 'warning', title: 'Review summary', evidence: 'Synthetic evidence', action: 'Revise', target: 'summary', ...(request.proposedValue === undefined ? {} : { proposedValue: request.proposedValue }) }
            : { area: 'resume', severity: 'pass', title: 'Fixture', evidence: 'Synthetic', action: 'None' },
            ...(request.letterId ? [{ area: 'cover_letter', severity: 'pass', title: 'Letter fixture', evidence: 'Synthetic', action: 'None' }] : [])],
        }) }
      },
      parseAiJson: (value: string) => JSON.parse(value),
      withMiniMaxThinking: (cfg: unknown) => cfg,
    }))
    const audit = await import('./route')
    postAudit = audit.POST
    getAudit = audit.GET
    const pack = await import('../application-pack/route')
    postPack = pack.POST
    getPack = pack.GET
    postRepair = (await import('./apply/route')).POST
    postTailor = (await import('../tailor-resume/route')).POST
    signedAuditActivityText = (await import('@/lib/application-audit-receipt')).signedAuditActivityText
    registerAuditOperation = (await import('@/lib/application-audit-operation')).registerAuditOperation
  }, 30_000)

  beforeEach(async () => {
    await clientA.activity.deleteMany()
    await clientA.resumeVersion.deleteMany()
    await clientA.coverLetter.deleteMany()
    await clientA.job.deleteMany()
    await clientA.resume.deleteMany()
    const content = { contact: { name: 'Synthetic Candidate' }, summary: 'Synthetic summary', experience: [], education: [], skills: [] }
    const source = await clientA.resume.create({ data: { id: 'source-1', userId: 'owner-a', name: 'Source', content } })
    const resume = await clientA.resume.create({ data: { id: 'resume-1', userId: 'owner-a', name: 'Tailored', parentResumeId: source.id, content } })
    await clientA.job.create({ data: { id: 'job-1', userId: 'owner-a', role: 'Engineer', company: 'Fixture', description: 'Synthetic role', finalResumeId: resume.id } })
    const baseline = await invoke('audit', { client: clientA, userId: 'owner-a', summary: 'Old passing audit' })
    expect(baseline.status).toBe(200)
  })

  afterAll(async () => {
    for (const name of ['@/lib/api-helpers', '@/lib/db', '@/lib/auth-secret', '@/lib/persona', '@/lib/persona-evidence', '@/lib/entitlements', '@/lib/agent/policy/legacy', '@/lib/agent/role-config', '@/lib/model-router']) vi.doUnmock(name)
    vi.resetModules()
    await clientA?.$disconnect()
    await clientB?.$disconnect()
    if (schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
    await admin?.$disconnect()
  }, 30_000)

  let lastAuditOperationId = '11111111-1111-4111-8111-111111111111'
  async function invoke(kind: 'audit' | 'read' | 'download' | 'print' | 'repair', scope: RequestScope): Promise<Response> {
    const path = kind === 'repair' ? 'audit-application/apply' : kind === 'audit' || kind === 'read' ? 'audit-application' : 'application-pack'
    const method = kind === 'audit' || kind === 'download' || kind === 'repair' ? 'POST' : 'GET'
    const request = new NextRequest(`http://localhost/api/jobs/job-1/${path}`, {
      method, ...(kind === 'audit' || kind === 'repair' ? { headers: { 'Content-Type': 'application/json', ...(scope.auditAttemptId ? { 'X-Application-Audit-Attempt-Id': scope.auditAttemptId } : {}) }, body: JSON.stringify({ resumeId: 'resume-1', ...(scope.letterId ? { coverLetterId: scope.letterId } : {}), ...(kind === 'repair' ? { findingIndex: 0, auditOperationId: scope.auditOperationId ?? lastAuditOperationId } : {}) }) } : {}),
    })
    const params = { params: Promise.resolve({ id: 'job-1' }) }
    const response = await requestScope.run(scope, () => kind === 'audit' ? postAudit(request, params) : kind === 'repair' ? postRepair(request, params)
      : kind === 'read' ? getAudit(request, params) : kind === 'download' ? postPack(request, params) : getPack(request, params))
    if (!(response instanceof Response)) throw new Error('Route did not return a response')
    if (kind === 'audit' && response.ok) {
      const data: unknown = await response.clone().json()
      if (data && typeof data === 'object' && 'operationId' in data && typeof data.operationId === 'string') lastAuditOperationId = data.operationId
    }
    return response
  }

  async function invokeTailor(scope: RequestScope, captured?: { receipt: { signature: string }; operationId: string }): Promise<Response> {
    const audit = captured ?? await (await invoke('read', { client: scope.client, userId: scope.userId })).json()
    const request = new NextRequest('http://localhost/api/jobs/job-1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume-1', forceRetailor: true, auditReceiptSignature: audit.receipt?.signature, auditOperationId: audit.operationId, auditFindings: [
        { area: 'resume', severity: 'warning', target: 'summary', title: 'Review summary', evidence: 'Synthetic', action: 'Correct' },
      ] }),
    })
    const response = await requestScope.run({ ...scope, tailor: true }, () => postTailor(request, { params: Promise.resolve({ id: 'job-1' }) }))
    if (!(response instanceof Response)) throw new Error('Tailor route did not return a response')
    return response
  }

  async function seedTailoredResume() {
    const resume = await clientA.resume.update({ where: { id: 'resume-1' }, data: { kind: 'adapted', origin: 'ai-adapted', targetJobId: 'job-1' } })
    expect((await invoke('audit', { client: clientA, userId: 'owner-a', review: true })).status).toBe(200)
    return resume
  }

  it('hides an old pass while a new audit is running and rejects pack and print', async () => {
    expect((await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).audit.summary).toBe('Old passing audit')
    const running = gate()
    const pending = invoke('audit', { client: clientA, userId: 'owner-a', summary: 'New pass', gate: running })
    try {
      await within(running.reached)
      const read = await invoke('read', { client: clientB, userId: 'owner-a' })
      expect(read.status).toBe(200)
      expect(await read.json()).toMatchObject({ state: 'pending' })
      expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
      expect((await invoke('print', { client: clientB, userId: 'owner-a' })).status).toBe(409)
      running.release()
      expect((await within(pending)).status).toBe(200)
      expect((await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).audit.summary).toBe('New pass')
    } finally { running.release(); await within(Promise.allSettled([pending])) }
  }, 30_000)

  it('rejects an oversized selected resume and does not reuse the earlier pass', async () => {
    await clientB.resume.update({ where: { id: 'resume-1' }, data: { content: { summary: 'x'.repeat(12_000) } } })
    const rejected = await invoke('audit', { client: clientA, userId: 'owner-a' })
    expect(rejected.status).toBe(422)
    expect((await rejected.json()).error).toContain('final resume')
    expect(await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).toEqual({ state: 'stale' })
    expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    expect((await invoke('print', { client: clientB, userId: 'owner-a' })).status).toBe(409)
  })

  it('echoes an oversized-document attempt without changing an existing audit control', async () => {
    const before = await clientB.activity.findMany({ orderBy: { id: 'asc' } })
    expect(before.length).toBeGreaterThan(0)
    await clientB.resume.update({ where: { id: 'resume-1' }, data: { content: { summary: 'x'.repeat(12_000) } } })
    const attempt = 'be8fcfd3-6ce5-4e17-9d59-fde9f7b85a56'
    const request = new NextRequest('http://localhost/api/jobs/job-1/audit-application', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Application-Audit-Attempt-Id': attempt },
      body: JSON.stringify({ resumeId: 'resume-1' }),
    })
    const rejected = await requestScope.run({ client: clientA, userId: 'owner-a' }, () => postAudit(request, { params: Promise.resolve({ id: 'job-1' }) }))
    if (!rejected) throw new Error('Audit route did not return a response')
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toEqual({ error: AUDIT_LIMIT_MESSAGES.final_resume_too_long, code: 'AUDIT_PRECHECK_NOT_REGISTERED', auditAttemptId: attempt, auditRegistration: 'not_started' })
    const after = await clientB.activity.findMany({ orderBy: { id: 'asc' } })
    expect(after).toHaveLength(before.length)
    expect(after).toEqual(before)
    expect(await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).toEqual({ state: 'stale' })
  })

  it('fences an earlier pass when the source evidence is too long to review', async () => {
    await clientB.resume.update({ where: { id: 'source-1' }, data: { content: { summary: 'x'.repeat(12_000) } } })
    const rejected = await invoke('audit', { client: clientA, userId: 'owner-a' })
    expect(rejected.status).toBe(422)
    expect((await rejected.json()).error).toContain('source resume')
    expect(await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).toEqual({ state: 'failed' })
    expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    expect((await invoke('print', { client: clientB, userId: 'owner-a' })).status).toBe(409)
  })

  it('prevents a superseded audit from publishing late or restoring its result', async () => {
    const firstGate = gate()
    const first = invoke('audit', { client: clientA, userId: 'owner-a', summary: 'Older result', gate: firstGate })
    try {
      await within(firstGate.reached)
      const second = await within(invoke('audit', { client: clientB, userId: 'owner-a', summary: 'Newer result' }))
      expect(second.status).toBe(200)
      expect((await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).audit.summary).toBe('Newer result')
      firstGate.release()
      expect((await within(first)).status).toBe(409)
      expect((await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).audit.summary).toBe('Newer result')
    } finally { firstGate.release(); await within(Promise.allSettled([first])) }
  }, 30_000)

  it('does not reveal or supersede another account’s pending audit', async () => {
    const running = gate()
    const pending = invoke('audit', { client: clientA, userId: 'owner-a', summary: 'Owner result', gate: running })
    try {
      await within(running.reached)
      const foreignRead = await invoke('read', { client: clientB, userId: 'owner-b' })
      expect([200, 404]).toContain(foreignRead.status)
      const foreignBody = await foreignRead.json()
      expect(JSON.stringify(foreignBody)).not.toContain('Old passing audit')
      expect(JSON.stringify(foreignBody)).not.toContain('pending')
      expect((await invoke('download', { client: clientB, userId: 'owner-b' })).status).toBe(404)
      expect((await invoke('audit', { client: clientB, userId: 'owner-b', summary: 'Foreign result' })).status).toBe(404)
      expect(await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).toMatchObject({ state: 'pending' })
      running.release()
      expect((await within(pending)).status).toBe(200)
    } finally { running.release(); await within(Promise.allSettled([pending])) }
  }, 30_000)

  it('requires a new audit for a legacy signed record without job identity', async () => {
    await clientA.activity.deleteMany()
    const resume = await clientA.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })
    const audit = { verdict: 'pass' as const, summary: 'Legacy audit', matchScore: 80, source: 'parent_resume' as const,
      auditedAt: new Date().toISOString(), findings: [{ area: 'resume' as const, severity: 'pass' as const, title: 'Fixture', evidence: 'Synthetic', action: 'None' }] }
    await clientA.activity.create({ data: { userId: 'owner-a', jobId: 'job-1', type: 'agent_action',
      text: signedAuditActivityText({ userId: 'owner-a', jobId: 'job-1' }, resume.id, null, audit, { resumeUpdatedAt: resume.updatedAt.toISOString() }) } })
    const read = await invoke('read', { client: clientB, userId: 'owner-a' })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ state: 'stale' })
    expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    expect((await invoke('print', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    expect((await invoke('repair', { client: clientB, userId: 'owner-a' })).status).toBe(409)
  }, 30_000)

  it('cannot publish an audit after the job description changes during model work', async () => {
    const running = gate()
    const pending = invoke('audit', { client: clientA, userId: 'owner-a', summary: 'Outdated job audit', gate: running })
    try {
      await within(running.reached)
      await clientB.job.update({ where: { id: 'job-1' }, data: { description: 'Changed synthetic role' } })
      running.release()
      expect((await within(pending)).status).toBe(409)
      const state = await invoke('read', { client: clientB, userId: 'owner-a' })
      expect(state.status).toBe(200)
      expect((await state.json()).audit?.verdict).not.toBe('pass')
      expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    } finally { running.release(); await within(Promise.allSettled([pending])) }
  }, 30_000)

  it.each(['role', 'company', 'description'] as const)('marks an existing audit stale after the job %s changes', async field => {
    const originalJob = await clientA.job.findUniqueOrThrow({ where: { id: 'job-1' } })
    await clientB.job.update({ where: { id: 'job-1' }, data: { [field]: `Changed ${field}` } })
    const read = await invoke('read', { client: clientB, userId: 'owner-a' })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ state: 'stale' })
    expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    expect((await invoke('print', { client: clientB, userId: 'owner-a' })).status).toBe(409)

    // Use an actually repairable result so a 409 proves the job-basis gate,
    // rather than the earlier 400 guard for pass findings.
    await clientB.job.update({ where: { id: 'job-1' }, data: { [field]: originalJob[field] } })
    const review = await invoke('audit', { client: clientA, userId: 'owner-a', review: true, proposedValue: 'Synthetic corrected summary' })
    expect(review.status).toBe(200)
    expect((await review.json()).findings[0]).toMatchObject({ area: 'resume', severity: 'warning', target: 'summary', proposedValue: 'Synthetic corrected summary' })
    const beforeResume = await clientA.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })
    const beforeVersions = await clientA.resumeVersion.count({ where: { resumeId: 'resume-1', userId: 'owner-a' } })
    await clientB.job.update({ where: { id: 'job-1' }, data: { [field]: `Changed ${field}` } })
    expect((await invoke('repair', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    const afterResume = await clientA.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })
    expect(afterResume.content).toEqual(beforeResume.content)
    expect(afterResume.updatedAt).toEqual(beforeResume.updatedAt)
    expect(await clientA.resumeVersion.count({ where: { resumeId: 'resume-1', userId: 'owner-a' } })).toBe(beforeVersions)
  })

  async function seedLetter() {
    const letter = await clientA.coverLetter.create({ data: {
      id: 'letter-1', userId: 'owner-a', jobId: 'job-1', resumeId: 'resume-1', content: 'Synthetic original letter',
    } })
    await clientA.job.update({ where: { id: 'job-1' }, data: { finalCoverLetterId: letter.id } })
    return letter
  }

  it.each(['resume', 'letter'] as const)('rejects a changed %s even when its updatedAt stays the same during review', async material => {
    const letter = material === 'letter' ? await seedLetter() : null
    const resume = await clientA.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })
    const running = gate()
    const review = invoke('audit', { client: clientA, userId: 'owner-a', summary: 'Must not publish', gate: running, letterId: letter?.id })
    try {
      await within(running.reached)
      if (letter) {
        await clientB.coverLetter.update({ where: { id: letter.id }, data: { content: 'Different letter', updatedAt: letter.updatedAt } })
        const changed = await clientB.coverLetter.findUniqueOrThrow({ where: { id: letter.id } })
        expect(changed.updatedAt).toEqual(letter.updatedAt)
        expect(changed.content).not.toBe(letter.content)
      } else {
        await clientB.resume.update({ where: { id: resume.id }, data: { content: { summary: 'Different resume' }, updatedAt: resume.updatedAt } })
        const changed = await clientB.resume.findUniqueOrThrow({ where: { id: resume.id } })
        expect(changed.updatedAt).toEqual(resume.updatedAt)
        expect(changed.content).not.toEqual(resume.content)
      }
      running.release()
      expect((await within(review)).status).toBe(409)
      const state = await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()
      expect(state.audit?.verdict).not.toBe('pass')
      expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    } finally { running.release(); await within(Promise.allSettled([review])) }
  }, 30_000)

  it.each(['resume', 'letter'] as const)('marks a completed audit stale if %s content changes with the same updatedAt', async material => {
    const letter = material === 'letter' ? await seedLetter() : null
    if (letter) expect((await invoke('audit', { client: clientA, userId: 'owner-a', letterId: letter.id })).status).toBe(200)
    const resume = await clientA.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })
    if (letter) {
      await clientB.coverLetter.update({ where: { id: letter.id }, data: { content: 'Different letter', updatedAt: letter.updatedAt } })
      expect((await clientB.coverLetter.findUniqueOrThrow({ where: { id: letter.id } })).updatedAt).toEqual(letter.updatedAt)
    } else {
      await clientB.resume.update({ where: { id: resume.id }, data: { content: { summary: 'Different resume' }, updatedAt: resume.updatedAt } })
      expect((await clientB.resume.findUniqueOrThrow({ where: { id: resume.id } })).updatedAt).toEqual(resume.updatedAt)
    }
    expect(await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).toEqual({ state: 'stale' })
    expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    expect((await invoke('print', { client: clientB, userId: 'owner-a' })).status).toBe(409)
  })

  it('keeps a current audit when resume and letter bytes and timestamps remain unchanged', async () => {
    const letter = await seedLetter()
    expect((await invoke('audit', { client: clientA, userId: 'owner-a', letterId: letter.id, summary: 'Current pair' })).status).toBe(200)
    const resume = await clientA.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })
    await clientB.resume.update({ where: { id: resume.id }, data: { content: resume.content as object, updatedAt: resume.updatedAt } })
    await clientB.coverLetter.update({ where: { id: letter.id }, data: { content: letter.content, updatedAt: letter.updatedAt } })
    const current = await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()
    expect(current.audit).toMatchObject({ verdict: 'pass', summary: 'Current pair' })
  })

  it.each([
    ['resume', 'download'], ['letter', 'download'], ['resume', 'audit'], ['letter', 'audit'],
  ] as const)('returns a conflict on %s lock contention during %s', async (material, action) => {
    if (material === 'letter') await seedLetter()
    const before = await clientA.activity.findMany({ orderBy: { id: 'asc' } })
    const held = gate()
    const getJob = gate()
    const evidence: LockEvidence = { started: () => {}, issued: () => {}, rawErrors: [] }
    const holder = clientB.$transaction(async tx => {
      if (material === 'letter') await tx.$queryRaw`SELECT "id" FROM "CoverLetter" WHERE "id" = 'letter-1' FOR UPDATE`
      else await tx.$queryRaw`SELECT "id" FROM "Resume" WHERE "id" = 'resume-1' FOR UPDATE`
      held.entered()
      await getJob.waiting
      // The conflicting request must have rolled back its Job lock first.
      await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = 'job-1' FOR UPDATE NOWAIT`
    }, { timeout: 15_000 })
    try {
      await within(held.reached)
      const response = await within(invoke(action, { client: clientA, userId: 'owner-a', evidence, ...(material === 'letter' ? { letterId: 'letter-1' } : {}) }), 5_000)
      expect(response.status).toBe(409)
      expect(evidence.rawErrors).toHaveLength(1)
      const error = evidence.rawErrors![0] as { code?: unknown; meta?: { code?: unknown } }
      expect(error.code).toBe('P2010')
      expect(error.meta?.code).toBe('55P03')
      getJob.release()
      await within(holder)
      expect(await clientA.activity.findMany({ orderBy: { id: 'asc' } })).toEqual(before)
    } finally { getJob.release(); await within(Promise.allSettled([holder])) }
  }, 30_000)

  it('uses lock order rather than transaction start time for a delayed read', async () => {
    const queryGate = gate()
    const transactionStarted = gate()
    const queryIssued = gate()
    const heldLock = gate()
    const evidence: LockEvidence = { started: transactionStarted.entered, issued: queryIssued.entered, beforeQuery: queryGate.waiting }
    const read = invoke('read', { client: clientB, userId: 'owner-a', evidence })
    let holderPid: number | undefined
    let holderStarted: Date | undefined
    const holder = (async () => {
      await within(transactionStarted.reached)
      // Ensure the two PostgreSQL transaction timestamps are distinguishable;
      // the correctness assertion below observes actual lock contention.
      await new Promise(resolve => setTimeout(resolve, 30))
      return clientA.$transaction(async tx => {
        const info = await tx.$queryRaw<Array<{ pid: number; startedAt: Date }>>`SELECT pg_backend_pid() AS pid, transaction_timestamp() AS "startedAt"`
        holderPid = info[0].pid
        holderStarted = info[0].startedAt
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = 'job-1' AND "userId" = 'owner-a' FOR UPDATE`
        await registerAuditOperation(tx, { userId: 'owner-a', jobId: 'job-1' })
        heldLock.entered()
        await heldLock.waiting
      }, { timeout: 15_000 })
    })()
    try {
      await within(heldLock.reached)
      expect(evidence.startedAt!.getTime()).toBeLessThan(holderStarted!.getTime())
      queryGate.release()
      await within(queryIssued.reached)
      const deadline = Date.now() + 8_000
      let blocked = false
      while (!blocked && Date.now() < deadline) {
        const rows = await within(admin.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT ${holderPid!}::int = ANY(pg_blocking_pids(${evidence.pid!}::int)) AS blocked`, 2_000)
        blocked = rows[0]?.blocked === true
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(blocked).toBe(true)
      heldLock.release()
      const response = await within(read)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ state: 'pending' })
      await within(holder)
    } finally {
      queryGate.release()
      heldLock.release()
      await within(Promise.allSettled([read, holder]))
    }
  }, 30_000)

  async function seedRepair(proposedValue?: string) {
    const resume = await clientA.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })
    expect((await invoke('audit', { client: clientA, userId: 'owner-a', summary: 'Review this summary', review: true, proposedValue })).status).toBe(200)
    return resume
  }

  it('rejects review A finding index after B replaced it before the repair request', async () => {
    const reviewA = await invoke('audit', { client: clientA, userId: 'owner-a', review: true, summary: 'Review A', proposedValue: 'Correction A' })
    expect(reviewA.status).toBe(200)
    const operationA = (await reviewA.json()).operationId as string
    const reviewB = await invoke('audit', { client: clientB, userId: 'owner-a', review: true, summary: 'Review B', proposedValue: 'Correction B' })
    expect(reviewB.status).toBe(200)
    const operationB = (await reviewB.json()).operationId as string
    expect(operationB).not.toBe(operationA)
    const before = await clientA.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })
    const beforeVersions = await clientA.resumeVersion.findMany({ where: { resumeId: 'resume-1' }, orderBy: { id: 'asc' } })
    const beforeActivities = await clientA.activity.findMany({ orderBy: { id: 'asc' } })
    const beforeLetters = await clientA.coverLetter.findMany({ orderBy: { id: 'asc' } })
    const attemptId = '22222222-2222-4222-8222-222222222222'
    const rejected = await invoke('repair', { client: clientA, userId: 'owner-a', auditOperationId: operationA, auditAttemptId: attemptId })
    expect(rejected.status).toBe(409)
    expect(rejected.headers.get('Cache-Control')).toBe('no-store, private')
    expect(await rejected.json()).toMatchObject({ code: 'AUDIT_CORRECTION_NOT_STARTED', auditAttemptId: attemptId, correctionWrite: 'not_started' })
    expect(await clientB.resume.findUniqueOrThrow({ where: { id: 'resume-1' } })).toEqual(before)
    expect(await clientB.resumeVersion.findMany({ where: { resumeId: 'resume-1' }, orderBy: { id: 'asc' } })).toEqual(beforeVersions)
    expect(await clientB.activity.findMany({ orderBy: { id: 'asc' } })).toEqual(beforeActivities)
    expect(await clientB.coverLetter.findMany({ orderBy: { id: 'asc' } })).toEqual(beforeLetters)
    const accepted = await invoke('repair', { client: clientB, userId: 'owner-a', auditOperationId: operationB })
    expect(accepted.status).toBe(200)
    const response = await accepted.json()
    expect(response.appliedContent).toBe('Correction B')
    expect(response.operationId).not.toBe(operationB)
    expect((await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()).operationId).toBe(response.operationId)
  }, 30_000)

  it('does not write a correction whose generation overlaps a newer audit', async () => {
    const before = await seedRepair()
    const model = gate()
    const repair = invoke('repair', { client: clientA, userId: 'owner-a', repair: true, gate: model })
    try {
      await within(model.reached)
      expect((await invoke('audit', { client: clientB, userId: 'owner-a', summary: 'Replacement audit' })).status).toBe(200)
      model.release()
      expect((await within(repair)).status).toBe(409)
      expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toEqual(before.content)
      expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(0)
      expect((await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).audit.summary).toBe('Replacement audit')
    } finally { model.release(); await within(Promise.allSettled([repair])) }
  }, 30_000)

  it('rolls back a correction and version if its audit control cannot be saved', async () => {
    const before = await seedRepair('Synthetic corrected summary')
    await clientA.$executeRawUnsafe(`ALTER TABLE "${schema}"."Activity" ADD CONSTRAINT reject_audit_control CHECK ("text" NOT LIKE '%"state":"pending"%')`)
    try {
      expect((await invoke('repair', { client: clientA, userId: 'owner-a' })).status).toBe(503)
      expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toEqual(before.content)
      expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(0)
      expect((await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).audit.summary).toBe('Review this summary')
    } finally { await clientA.$executeRawUnsafe(`ALTER TABLE "${schema}"."Activity" DROP CONSTRAINT reject_audit_control`) }
  }, 30_000)

  it.each(['changed timestamp', 'same timestamp'] as const)('does not overwrite another saved resume during forced repair with %s', async mode => {
    const before = await seedTailoredResume()
    const model = gate()
    const pending = invokeTailor({ client: clientA, userId: 'owner-a', gate: model })
    try {
      await within(model.reached)
      const editedContent = { ...(before.content as object), summary: 'User saved a different summary', skills: ['User-preserved skill'] }
      const savedAt = mode === 'same timestamp' ? before.updatedAt : new Date(before.updatedAt.getTime() + 10_000)
      await clientB.resume.update({ where: { id: before.id }, data: { content: editedContent, updatedAt: savedAt } })
      const saved = await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })
      expect(saved.content).toEqual(editedContent)
      expect(saved.updatedAt).toEqual(savedAt)
      model.release()
      const response = await within(pending)
      expect(response.status).toBe(409)
      const after = await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })
      expect(after.content).toEqual(editedContent)
      expect(after.updatedAt).toEqual(savedAt)
      expect(await clientB.resumeVersion.count({ where: { resumeId: before.id, userId: 'owner-a' } })).toBe(0)
    } finally { model.release(); await within(Promise.allSettled([pending])) }
  }, 30_000)

  it.each(['targetJobId', 'parentResumeId'] as const)('rejects forced repair when %s changes during model work without a timestamp or content change', async field => {
    const before = await seedTailoredResume()
    // Both alternative references really exist and belong to the same account.
    // The disposable fixture schema does not itself enforce foreign keys.
    await clientA.job.create({ data: { id: 'job-2', userId: 'owner-a', role: 'Other role', company: 'Fixture', description: 'Other synthetic role' } })
    await clientA.resume.create({ data: { id: 'source-2', userId: 'owner-a', name: 'Other source', content: before.content as object } })
    const alternate = field === 'targetJobId' ? 'job-2' : 'source-2'
    const originalVersions = await clientB.resumeVersion.count({ where: { resumeId: before.id, userId: 'owner-a' } })
    const model = gate()
    const pending = invokeTailor({ client: clientA, userId: 'owner-a', gate: model })
    try {
      await within(model.reached)
      await clientB.resume.update({ where: { id: before.id }, data: { [field]: alternate, updatedAt: before.updatedAt } })
      const saved = await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })
      expect(saved[field]).toBe(alternate)
      expect(saved.content).toEqual(before.content)
      expect(saved.updatedAt).toEqual(before.updatedAt)
      model.release()
      const response = await within(pending)
      expect(response.status).toBe(409)
      const after = await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })
      expect(after[field]).toBe(alternate)
      expect(after.content).toEqual(before.content)
      expect(after.updatedAt).toEqual(before.updatedAt)
      expect(await clientB.resumeVersion.count({ where: { resumeId: before.id, userId: 'owner-a' } })).toBe(originalVersions)
    } finally { model.release(); await within(Promise.allSettled([pending])) }
  }, 30_000)

  it('rejects forced repair when the audited resume changed before the request', async () => {
    const before = await seedTailoredResume()
    const receipt = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    const edited = { ...(before.content as object), summary: 'Already corrected by user' }
    await clientB.resume.update({ where: { id: before.id }, data: { content: edited } })
    expect((await invokeTailor({ client: clientA, userId: 'owner-a' }, receipt)).status).toBe(409)
    expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toEqual(edited)
    expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(0)
  })

  it('rejects forced repair when the audited cover letter changed before the request', async () => {
    const before = await seedTailoredResume()
    const letter = await seedLetter()
    expect((await invoke('audit', { client: clientA, userId: 'owner-a', review: true, letterId: letter.id })).status).toBe(200)
    const receipt = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    await clientB.coverLetter.update({ where: { id: letter.id }, data: { content: 'Edited after review' } })
    expect((await invokeTailor({ client: clientA, userId: 'owner-a' }, receipt)).status).toBe(409)
    expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toEqual(before.content)
    expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(0)
  })

  it('allows a reviewed tailored resume before final selection', async () => {
    const before = await seedTailoredResume()
    await clientA.job.update({ where: { id: 'job-1' }, data: { finalResumeId: null } })
    const receipt = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    expect((await invokeTailor({ client: clientA, userId: 'owner-a' }, receipt)).status).toBe(200)
    expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toMatchObject({ summary: 'Synthetic corrected summary' })
  })

  it('rejects forced repair superseded by a newer audit while the model runs', async () => {
    const before = await seedTailoredResume()
    const receipt = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    const model = gate()
    const pending = invokeTailor({ client: clientA, userId: 'owner-a', gate: model }, receipt)
    try {
      await within(model.reached)
      expect((await invoke('audit', { client: clientB, userId: 'owner-a', review: true, summary: 'Replacement review' })).status).toBe(200)
      model.release()
      expect((await within(pending)).status).toBe(409)
      expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toEqual(before.content)
      expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(0)
    } finally { model.release(); await within(Promise.allSettled([pending])) }
  }, 30_000)

  it('rejects an old operation even when a newer signed audit is byte-for-byte identical', async () => {
    const before = await seedTailoredResume()
    const old = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    const { completeAuditOperation } = await import('@/lib/application-audit-operation')
    await clientB.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = 'job-1' AND "userId" = 'owner-a' FOR UPDATE`
      const job = await tx.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      const resume = await tx.resume.findUniqueOrThrow({ where: { id: before.id } })
      const scope = { userId: 'owner-a', jobId: 'job-1' }
      const id = await registerAuditOperation(tx, scope)
      expect(await completeAuditOperation(tx, scope, id, { resumeId: before.id, coverLetterId: null, audit: old.audit, jobBasis: job,
        materialBasis: { resume, coverLetter: null }, versions: { resumeUpdatedAt: old.resumeUpdatedAt } })).toBe(true)
    })
    const replacement = await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()
    expect(replacement.receipt.signature).toBe(old.receipt.signature)
    expect(replacement.operationId).not.toBe(old.operationId)
    expect((await invokeTailor({ client: clientA, userId: 'owner-a' }, old)).status).toBe(409)
    expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toEqual(before.content)
    expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(0)
  })

  it.each(['unselect', 'select'] as const)('rejects forced repair if the final resume selection changes during model work: %s', async direction => {
    const before = await seedTailoredResume()
    if (direction === 'select') await clientA.job.update({ where: { id: 'job-1' }, data: { finalResumeId: null } })
    const receipt = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    const model = gate()
    const pending = invokeTailor({ client: clientA, userId: 'owner-a', gate: model }, receipt)
    try {
      await within(model.reached)
      await clientB.job.update({ where: { id: 'job-1' }, data: { finalResumeId: direction === 'select' ? before.id : null } })
      model.release()
      expect((await within(pending)).status).toBe(409)
      expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toEqual(before.content)
      expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(0)
    } finally { model.release(); await within(Promise.allSettled([pending])) }
  }, 30_000)

  it('waits for a newly registered audit holding the Job lock, then rejects the old repair', async () => {
    const before = await seedTailoredResume()
    const receipt = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    const model = gate(), hold = gate(), started = gate(), issued = gate(), query = gate()
    const evidence: LockEvidence = { started: started.entered, issued: issued.entered, beforeQuery: query.waiting }
    const pending = invokeTailor({ client: clientA, userId: 'owner-a', gate: model, evidence }, receipt)
    let holderPid = 0
    let holder: Promise<unknown> | undefined
    try {
      await within(model.reached)
      holder = clientB.$transaction(async tx => {
        holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = 'job-1' AND "userId" = 'owner-a' FOR UPDATE`
        await registerAuditOperation(tx, { userId: 'owner-a', jobId: 'job-1' })
        hold.entered()
        await hold.waiting
      }, { timeout: 15_000 })
      await within(hold.reached)
      model.release()
      await within(started.reached)
      query.release()
      await within(issued.reached)
      let blocked = false
      const deadline = Date.now() + 8_000
      while (!blocked && Date.now() < deadline) {
        blocked = (await admin.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${holderPid}::int = ANY(pg_blocking_pids(${evidence.pid!}::int)) AS blocked`)[0].blocked
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(blocked).toBe(true)
      hold.release()
      await within(holder)
      expect((await within(pending)).status).toBe(409)
      expect((await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })).content).toEqual(before.content)
      expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(0)
    } finally { model.release(); query.release(); hold.release(); await within(Promise.allSettled([pending, ...(holder ? [holder] : [])])) }
  }, 30_000)

  it('holds the Job lock through the repair commit before a competing audit may register', async () => {
    await seedTailoredResume()
    const receipt = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    const update = gate(), aStarted = gate(), aIssued = gate(), aQuery = gate()
    const aEvidence: LockEvidence = { started: aStarted.entered, issued: aIssued.entered, beforeQuery: aQuery.waiting }
    const bStarted = gate(), bIssued = gate(), bQuery = gate()
    const bEvidence: LockEvidence = { started: bStarted.entered, issued: bIssued.entered, beforeQuery: bQuery.waiting }
    aQuery.release()
    const repair = invokeTailor({ client: clientA, userId: 'owner-a', updateGate: update, evidence: aEvidence }, receipt)
    let audit: Promise<Response> | undefined
    try {
      await within(update.reached)
      audit = invoke('audit', { client: clientB, userId: 'owner-a', review: true, evidence: bEvidence })
      await within(bStarted.reached)
      bQuery.release()
      await within(bIssued.reached)
      let blocked = false
      const deadline = Date.now() + 8_000
      while (!blocked && Date.now() < deadline) {
        blocked = (await admin.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${aEvidence.pid!}::int = ANY(pg_blocking_pids(${bEvidence.pid!}::int)) AS blocked`)[0].blocked
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(blocked).toBe(true)
      update.release()
      expect((await within(repair)).status).toBe(200)
      expect((await within(audit)).status).toBe(409)
      expect(await clientB.resumeVersion.count({ where: { resumeId: 'resume-1' } })).toBe(1)
      expect(await (await invoke('read', { client: clientB, userId: 'owner-a' })).json()).toEqual({ state: 'stale' })
    } finally { aQuery.release(); bQuery.release(); update.release(); await within(Promise.allSettled([repair, ...(audit ? [audit] : [])])) }
  }, 30_000)

  it('saves forced repair with unrelated sections preserved and one pre-change history snapshot', async () => {
    const before = await seedTailoredResume()
    const receipt = await (await invoke('read', { client: clientA, userId: 'owner-a' })).json()
    const response = await invokeTailor({ client: clientA, userId: 'owner-a' }, receipt)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ adaptedResumeId: before.id, revised: true })
    const after = await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.content).toEqual({ ...(before.content as object), summary: 'Synthetic corrected summary' })
    const versions = await clientB.resumeVersion.findMany({ where: { resumeId: before.id, userId: 'owner-a' } })
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ name: before.name, content: before.content })
    expect((await invokeTailor({ client: clientA, userId: 'owner-a' }, receipt)).status).toBe(409)
    expect(await clientB.resumeVersion.count({ where: { resumeId: before.id } })).toBe(1)
  }, 30_000)

  it('rolls back the forced repair if its history snapshot cannot be saved', async () => {
    const before = await seedTailoredResume()
    await clientA.$executeRawUnsafe(`ALTER TABLE "${schema}"."ResumeVersion" ADD CONSTRAINT reject_tailor_history CHECK ("name" <> 'Tailored')`)
    try {
      const response = await invokeTailor({ client: clientA, userId: 'owner-a' })
      expect(response.status).toBe(503)
      const after = await clientB.resume.findUniqueOrThrow({ where: { id: before.id } })
      expect(after.content).toEqual(before.content)
      expect(after.updatedAt).toEqual(before.updatedAt)
      expect(await clientB.resumeVersion.count({ where: { resumeId: before.id, userId: 'owner-a' } })).toBe(0)
    } finally { await clientA.$executeRawUnsafe(`ALTER TABLE "${schema}"."ResumeVersion" DROP CONSTRAINT reject_tailor_history`) }
  }, 30_000)
})
