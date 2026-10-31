import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Opt in only to a separately named, disposable loopback database. This test
// creates and removes only its own randomly named schema; it uses no migrations.
const configuredUrl = process.env.MANUAL_RECORD_PG_TEST_URL
const disposable = process.env.MANUAL_RECORD_PG_TEST_DISPOSABLE
const enabled = Boolean(configuredUrl || disposable)
if (enabled) {
  let parsed: URL
  try { parsed = new URL(configuredUrl ?? '') } catch { throw new Error('Invalid disposable manual-record test configuration') }
  if (disposable !== 'true' || !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/applymate_manual_record_test'
    || !parsed.username || parsed.search || parsed.hash || process.env.RLS_RUNTIME_MODE !== 'off') {
    throw new Error('Manual-record integration requires the explicitly marked disposable loopback database with RLS off')
  }
}

type Barrier = { arrive: () => void; wait: Promise<void> }
type TransactionEvidence = {
  updateCounts: number[]
  activityCalls: number
  activityErrors: unknown[]
  backendPid?: number
  beforeUpdate?: () => Promise<void>
  onUpdateIssued?: () => void
  afterUpdate?: () => Promise<void>
}
type RequestScope = { client: PrismaClient; userId: string; barrier?: Barrier; evidence?: TransactionEvidence }
const scope = new AsyncLocalStorage<RequestScope>()
function currentScope(): RequestScope {
  const value = scope.getStore()
  if (!value) throw new Error('Missing manual-record test request scope')
  return value
}
function makeBarrier(count: number) {
  let arrivals = 0
  let signalReached = () => {}
  let release = () => {}
  const reached = new Promise<void>(resolve => { signalReached = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  return { reached, release, barrier: { arrive: () => { if (++arrivals === count) signalReached() }, wait } }
}
async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Manual-record test timed out')), ms) })])
  } finally { if (timeout) clearTimeout(timeout) }
}

const integration = enabled ? describe : describe.skip
integration('manual application record concurrency with PostgreSQL', () => {
  let admin: PrismaClient
  let clientA: PrismaClient
  let clientB: PrismaClient
  let schemaCreated = false
  let POST: typeof import('./route').POST
  const schema = `manual_record_${randomBytes(12).toString('hex')}`

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: configuredUrl! } } })
    await admin.$connect()
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    const schemaUrl = new URL(configuredUrl!)
    schemaUrl.searchParams.set('schema', schema)
    clientA = new PrismaClient({ datasources: { db: { url: schemaUrl.toString() } } })
    clientB = new PrismaClient({ datasources: { db: { url: schemaUrl.toString() } } })
    await clientA.$connect()
    await clientB.$connect()
    await clientA.$executeRawUnsafe(`CREATE TYPE "${schema}"."JobStatus" AS ENUM ('saved', 'applied', 'interview', 'offer', 'rejected')`)
    await clientA.$executeRawUnsafe(`CREATE TYPE "${schema}"."JobWorkflowState" AS ENUM ('draft', 'ready_to_apply', 'queued', 'submitting', 'submitted')`)
    await clientA.$executeRawUnsafe(`CREATE TYPE "${schema}"."ActivityType" AS ENUM ('applied')`)
    await clientA.$executeRawUnsafe(`CREATE TABLE "${schema}"."Job" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "company" TEXT NOT NULL,
      "logo" TEXT, "role" TEXT NOT NULL, "location" TEXT,
      "status" "${schema}"."JobStatus" NOT NULL DEFAULT 'saved', "score" INTEGER,
      "url" TEXT, "description" TEXT, "salary" TEXT, "source" TEXT, "notes" TEXT,
      "coverLetter" TEXT, "analysisNote" TEXT, "keywords" TEXT,
      "appliedAt" TIMESTAMP(3), "followUpAt" TIMESTAMP(3),
      "workflowState" "${schema}"."JobWorkflowState" NOT NULL DEFAULT 'draft',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finalResumeId" TEXT, "finalCoverLetterId" TEXT
    )`)
    await clientA.$executeRawUnsafe(`CREATE TABLE "${schema}"."Activity" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "jobId" TEXT,
      "type" "${schema}"."ActivityType" NOT NULL, "text" TEXT NOT NULL,
      "color" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    vi.doMock('@/lib/api-helpers', () => ({
      requireAuth: async () => ({ userId: currentScope().userId }),
      isErrorResponse: (value: unknown) => value instanceof Response,
      ok: (value: unknown, status = 200) => Response.json(value, { status }),
      err: (message: string, status = 400) => Response.json({ error: message }, { status }),
    }))
    vi.doMock('@/lib/entitlements', () => ({ checkEntitlementLimit: async () => ({ allowed: true, reason: 'available' }) }))
    vi.doMock('@/lib/cover-letter-retention', () => ({ purgeTemporaryGeneratedCoverLetters: async () => undefined }))
    // Only the ownership read is wrapped for the test barrier. All queries,
    // transactions and writes delegate to a real per-request PrismaClient.
    vi.doMock('@/lib/db', () => ({ db: {
      job: {
        findFirst: async (args: Prisma.JobFindFirstArgs) => {
          const request = currentScope()
          const row = await request.client.job.findFirst(args)
          if (request.barrier) { request.barrier.arrive(); await request.barrier.wait }
          return row
        },
        count: (args: Prisma.JobCountArgs) => currentScope().client.job.count(args),
      },
      $transaction: (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => {
        const request = currentScope()
        // A bounded but longer fixture timeout allows the test to observe the
        // actual blocked backend before releasing the winning transaction.
        return request.client.$transaction(async tx => {
          if (!request.evidence) return callback(tx)
          const evidence = request.evidence
          const backend = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          evidence.backendPid = backend[0].pid
          // Record actual database outcomes without replacing or faking queries.
          const observed = new Proxy(tx, { get(target, property, receiver) {
            if (property === 'job') return new Proxy(target.job, { get(delegate, operation, innerReceiver) {
              if (operation === 'updateMany') return async (args: Prisma.JobUpdateManyArgs) => {
                await evidence.beforeUpdate?.()
                const pending = Promise.resolve(delegate.updateMany(args))
                evidence.onUpdateIssued?.()
                const result = await pending
                evidence.updateCounts.push(result.count)
                await evidence.afterUpdate?.()
                return result
              }
              return Reflect.get(delegate, operation, innerReceiver)
            } })
            if (property === 'activity') return new Proxy(target.activity, { get(delegate, operation, innerReceiver) {
              if (operation === 'create') return async (args: Prisma.ActivityCreateArgs) => {
                evidence.activityCalls += 1
                try { return await delegate.create(args) } catch (error) { evidence.activityErrors.push(error); throw error }
              }
              return Reflect.get(delegate, operation, innerReceiver)
            } })
            return Reflect.get(target, property, receiver)
          } })
          return callback(observed)
        }, { timeout: 15_000 })
      },
    } }))
    POST = (await import('./route')).POST
  }, 30_000)

  beforeEach(async () => {
    await clientA.activity.deleteMany()
    await clientA.job.deleteMany()
    await clientA.job.create({ data: { id: 'job-1', userId: 'owner-a', company: 'Fixture', role: 'Engineer' } })
  })

  afterAll(async () => {
    vi.doUnmock('@/lib/api-helpers')
    vi.doUnmock('@/lib/entitlements')
    vi.doUnmock('@/lib/cover-letter-retention')
    vi.doUnmock('@/lib/db')
    vi.resetModules()
    await clientA?.$disconnect()
    await clientB?.$disconnect()
    if (schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
    await admin?.$disconnect()
  }, 30_000)

  function invoke(client: PrismaClient, barrier?: Barrier, requestId?: string, userId = 'owner-a', evidence?: TransactionEvidence) {
    const req = new NextRequest('http://localhost/api/jobs/job-1/apply', {
      method: 'POST', headers: requestId ? { 'X-Manual-Record-Request-Id': requestId } : {},
    })
    return scope.run({ client, userId, barrier, evidence }, () => POST(req, { params: Promise.resolve({ id: 'job-1' }) }))
  }

  it('commits only one record after both requests read the same saved job', async () => {
    const gate = makeBarrier(2)
    const winnerUpdated = makeBarrier(1)
    let signalSecondIssued = () => {}
    const secondIssued = new Promise<void>(resolve => { signalSecondIssued = resolve })
    let cancelSecondWait = () => {}
    let secondWaitCancelled = false
    const secondWaitCancellation = new Promise<void>(resolve => { cancelSecondWait = resolve })
    const winner: TransactionEvidence = {
      updateCounts: [], activityCalls: 0, activityErrors: [],
      afterUpdate: async () => { winnerUpdated.barrier.arrive(); await winnerUpdated.barrier.wait },
    }
    const loser: TransactionEvidence = {
      updateCounts: [], activityCalls: 0, activityErrors: [],
      beforeUpdate: async () => {
        await Promise.race([winnerUpdated.reached, secondWaitCancellation])
        if (secondWaitCancelled) throw new Error('Manual-record lock test cancelled before winner update')
      },
      onUpdateIssued: signalSecondIssued,
    }
    const first = invoke(clientA, gate.barrier, '6bce695c-3c62-4b6b-88b2-8b364629fb78', 'owner-a', winner)
    const second = invoke(clientB, gate.barrier, 'e9461354-91f4-49ea-80c2-198410c33783', 'owner-a', loser)
    const settled = Promise.allSettled([first, second])
    try {
      await within(gate.reached)
      gate.release()
      await within(winnerUpdated.reached)
      expect(winner.updateCounts).toEqual([1])
      await within(secondIssued)
      expect(winner.backendPid).toBeTypeOf('number')
      expect(loser.backendPid).toBeTypeOf('number')
      // The second query must actually be waiting on the first backend's lock;
      // merely starting two requests or reaching a JS barrier is insufficient.
      const deadline = Date.now() + 8_000
      let blocked = false
      while (!blocked && Date.now() < deadline) {
        const rows = await within(admin.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT ${winner.backendPid!}::int = ANY(pg_blocking_pids(${loser.backendPid!}::int)) AS blocked`, 2_000)
        blocked = rows[0]?.blocked === true
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(blocked).toBe(true)
      winnerUpdated.release()
      const responses = await within(Promise.all([first, second]))
      expect(responses.map(response => response.status)).toEqual([200, 409])
      expect(loser.updateCounts).toEqual([0])
      expect(winner.activityCalls).toBe(1)
      expect(loser.activityCalls).toBe(0)
      const job = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(job.status).toBe('applied')
      expect(job.workflowState).toBe('submitted')
      expect(job.appliedAt).toBeInstanceOf(Date)
      const activity = await clientB.activity.findMany({ where: { userId: 'owner-a', jobId: 'job-1' } })
      expect(activity).toHaveLength(1)
      expect(activity[0].type).toBe('applied')
      expect(activity[0].text).toBe('You applied manually Fixture · Engineer')
      const replay = await invoke(clientA)
      expect(replay.status).toBe(409)
      const afterReplay = await clientA.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(afterReplay.appliedAt?.getTime()).toBe(job.appliedAt?.getTime())
      expect(await clientA.activity.count({ where: { jobId: 'job-1' } })).toBe(1)
    } finally {
      gate.release()
      secondWaitCancelled = true
      cancelSecondWait()
      winnerUpdated.release()
      await within(settled)
    }
  }, 30_000)

  it('rolls the job transition back if its provenance write fails', async () => {
    await clientA.$executeRawUnsafe(`ALTER TABLE "${schema}"."Activity" ADD CONSTRAINT reject_fixture_activity CHECK ("text" <> 'You applied manually Fixture · Engineer')`)
    try {
      const evidence: TransactionEvidence = { updateCounts: [], activityCalls: 0, activityErrors: [] }
      const outcome = await Promise.allSettled([invoke(clientA, undefined, undefined, 'owner-a', evidence)])
      expect(outcome[0].status).toBe('rejected')
      expect(evidence.updateCounts).toEqual([1])
      expect(evidence.activityCalls).toBe(1)
      expect(evidence.activityErrors).toHaveLength(1)
      const error = evidence.activityErrors[0] as { message?: string; meta?: unknown }
      expect(`${String(error)} ${JSON.stringify(error.meta)}`).toContain('reject_fixture_activity')
      const job = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(job.status).toBe('saved')
      expect(job.workflowState).toBe('draft')
      expect(job.appliedAt).toBeNull()
      expect(await clientB.activity.count({ where: { jobId: 'job-1' } })).toBe(0)
    } finally { await clientA.$executeRawUnsafe(`ALTER TABLE "${schema}"."Activity" DROP CONSTRAINT reject_fixture_activity`) }
  }, 25_000)

  it('keeps the successful response for the existing caller without a request ID', async () => {
    const response = await invoke(clientA)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ applied: true })
    expect(await clientB.activity.count({ where: { jobId: 'job-1' } })).toBe(1)
  })

  it('does not write after ownership changes following the initial read', async () => {
    const gate = makeBarrier(1)
    const request = invoke(clientA, gate.barrier)
    try {
      await within(gate.reached)
      await clientB.job.update({ where: { id: 'job-1' }, data: { userId: 'owner-b' } })
      gate.release()
      expect((await within(request)).status).toBe(409)
      expect((await invoke(clientA, undefined, undefined, 'owner-a')).status).toBe(404)
      const job = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(job.userId).toBe('owner-b')
      expect(job.status).toBe('saved')
      expect(job.appliedAt).toBeNull()
      expect(await clientB.activity.count({ where: { jobId: 'job-1' } })).toBe(0)
    } finally { gate.release(); await within(Promise.allSettled([request])) }
  }, 25_000)

  it.each(['queued', 'submitting', 'submitted'] as const)(
    'does not overwrite an existing %s workflow', async workflowState => {
      await clientA.job.update({ where: { id: 'job-1' }, data: { workflowState } })
      expect((await invoke(clientB)).status).toBe(409)
      const job = await clientA.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(job.status).toBe('saved')
      expect(job.workflowState).toBe(workflowState)
      expect(job.appliedAt).toBeNull()
      expect(await clientA.activity.count({ where: { jobId: 'job-1' } })).toBe(0)
    },
  )

  it.each(['saved', 'applied', 'interview', 'offer', 'rejected'] as const)(
    'preserves a historical applied date in %s status', async status => {
      const previous = new Date('2024-02-03T04:05:06.000Z')
      await clientA.job.update({ where: { id: 'job-1' }, data: { status, appliedAt: previous } })
      expect((await invoke(clientB)).status).toBe(409)
      const job = await clientA.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(job.status).toBe(status)
      expect(job.appliedAt?.getTime()).toBe(previous.getTime())
      expect(await clientA.activity.count({ where: { jobId: 'job-1' } })).toBe(0)
    },
  )
})
