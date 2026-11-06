import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
type RequestScope = { client: PrismaClient; userId: string; summary?: string; gate?: ReturnType<typeof gate>; repair?: boolean; review?: boolean; proposedValue?: string; letterId?: string; evidence?: LockEvidence }
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
    await clientA.$executeRawUnsafe(`CREATE TYPE "${schema}"."ActivityType" AS ENUM ('agent_action')`)
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
        const { client, evidence } = current()
        return client.$transaction(async tx => {
          if (!evidence) return callback(tx)
          const rows = await tx.$queryRaw<Array<{ pid: number; startedAt: Date }>>`SELECT pg_backend_pid() AS pid, transaction_timestamp() AS "startedAt"`
          evidence.pid = rows[0].pid
          evidence.startedAt = rows[0].startedAt
          evidence.started()
          let first = true
          const observed = new Proxy(tx, { get(target, property, receiver) {
            if (property === '$queryRaw') return async (...args: unknown[]) => {
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
    vi.doMock('@/lib/agent/role-config', () => ({ roleAiConfig: (_role: string, _row: unknown, cfg: unknown) => cfg }))
    vi.doMock('@/lib/model-router', () => ({
      modelChat: async () => {
        const request = current()
        request.gate?.entered()
        await request.gate?.waiting
        if (request.repair) return { provider: 'fixture', model: 'fixture', text: JSON.stringify({ proposedValue: 'Synthetic corrected summary' }) }
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
    for (const name of ['@/lib/api-helpers', '@/lib/db', '@/lib/auth-secret', '@/lib/persona', '@/lib/agent/role-config', '@/lib/model-router']) vi.doUnmock(name)
    vi.resetModules()
    await clientA?.$disconnect()
    await clientB?.$disconnect()
    if (schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
    await admin?.$disconnect()
  }, 30_000)

  async function invoke(kind: 'audit' | 'read' | 'download' | 'print' | 'repair', scope: RequestScope): Promise<Response> {
    const path = kind === 'repair' ? 'audit-application/apply' : kind === 'audit' || kind === 'read' ? 'audit-application' : 'application-pack'
    const method = kind === 'audit' || kind === 'download' || kind === 'repair' ? 'POST' : 'GET'
    const request = new NextRequest(`http://localhost/api/jobs/job-1/${path}`, {
      method, ...(kind === 'audit' || kind === 'repair' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resumeId: 'resume-1', ...(scope.letterId ? { coverLetterId: scope.letterId } : {}), ...(kind === 'repair' ? { findingIndex: 0 } : {}) }) } : {}),
    })
    const params = { params: Promise.resolve({ id: 'job-1' }) }
    const response = await requestScope.run(scope, () => kind === 'audit' ? postAudit(request, params) : kind === 'repair' ? postRepair(request, params)
      : kind === 'read' ? getAudit(request, params) : kind === 'download' ? postPack(request, params) : getPack(request, params))
    if (!(response instanceof Response)) throw new Error('Route did not return a response')
    return response
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
    await clientB.job.update({ where: { id: 'job-1' }, data: { [field]: `Changed ${field}` } })
    const read = await invoke('read', { client: clientB, userId: 'owner-a' })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ state: 'stale' })
    expect((await invoke('download', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    expect((await invoke('print', { client: clientB, userId: 'owner-a' })).status).toBe(409)
    expect((await invoke('repair', { client: clientB, userId: 'owner-a' })).status).toBe(409)
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
})
