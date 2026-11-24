import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'

// This opt-in test only accepts an explicitly named, disposable loopback DB.
// No existing application database or migrations are touched.
const configuredUrl = process.env.DESCRIPTION_CAS_PG_TEST_URL
const disposable = process.env.DESCRIPTION_CAS_PG_TEST_DISPOSABLE
const enabled = Boolean(configuredUrl || disposable)
if (enabled) {
  let parsed: URL
  try { parsed = new URL(configuredUrl ?? '') } catch { throw new Error('Invalid disposable Job route test configuration') }
  if (disposable !== 'true' || !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/applymate_description_cas_test'
    || !parsed.username || parsed.search || parsed.hash) {
    throw new Error('Job route integration requires the explicitly marked disposable loopback database')
  }
}

type RequestScope = { userId: string }
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const scope = new AsyncLocalStorage<RequestScope>()
function currentScope(): RequestScope {
  const current = scope.getStore()
  if (!current) throw new Error('Missing test request scope')
  return current
}

async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Job route test timed out')), ms)
    })])
  } finally { if (timeout) clearTimeout(timeout) }
}

async function expectBlocked<T>(promise: Promise<T>) {
  const state = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 100)),
  ])
  expect(state).toBe('blocked')
}

async function waitForDatabaseLockWait(admin: PrismaClient) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = await admin.$queryRawUnsafe<Array<{ count: number }>>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND datname = current_database()
        AND wait_event_type = 'Lock'
    `)
    if ((rows[0]?.count ?? 0) > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Job route did not reach the expected PostgreSQL row-lock wait')
}

const integration = enabled ? describe : describe.skip
integration('Job PATCH and DELETE source fence with PostgreSQL', () => {
  let admin: PrismaClient
  let clientA: PrismaClient
  let clientB: PrismaClient
  let schemaCreated = false
  let PATCH: typeof import('./route').PATCH
  let DELETE: typeof import('./route').DELETE
  let routeDb: PrismaClient
  let ownsGlobalPrisma = false
  const originalDatabaseUrl = process.env.DATABASE_URL
  const schema = `description_cas_${randomBytes(12).toString('hex')}`

  beforeAll(async () => {
    // Safety validation above runs before creating a client or issuing any SQL.
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
      "finalResumeId" TEXT, "finalCoverLetterId" TEXT,
      "finalResumeAssignmentRevision" INTEGER NOT NULL DEFAULT 0
    )`)
    vi.doMock('@/lib/api-helpers', () => ({
      requireAuth: async () => ({ userId: currentScope().userId }),
      isErrorResponse: (value: unknown) => value instanceof Response,
      ok: (value: unknown, status = 200) => Response.json(value, { status }),
      err: (message: string, status = 400) => Response.json({ error: message }, { status }),
    }))
    if ((globalThis as unknown as { prisma?: unknown }).prisma || process.env.RLS_RUNTIME_MODE === 'on') {
      throw new Error('Job route test requires an isolated Prisma runtime with RLS disabled')
    }
    process.env.DATABASE_URL = schemaUrl.toString()
    routeDb = (await import('@/lib/db')).db
    ownsGlobalPrisma = Boolean((globalThis as unknown as { prisma?: unknown }).prisma)
    const route = await import('./route')
    PATCH = route.PATCH
    DELETE = route.DELETE
  }, 30_000)

  beforeEach(async () => {
    await clientA.job.deleteMany()
  })

  afterAll(async () => {
    vi.doUnmock('@/lib/api-helpers')
    await routeDb?.$disconnect()
    if (ownsGlobalPrisma) delete (globalThis as unknown as { prisma?: unknown }).prisma
    vi.resetModules()
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalDatabaseUrl
    await clientA?.$disconnect()
    await clientB?.$disconnect()
    if (schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
    await admin?.$disconnect()
  }, 30_000)

  function invokePatch(userId: string, description: string, expected: string | null) {
    const request = new NextRequest('http://localhost/api/jobs/job-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description, expectedEmptyDescription: expected }),
    })
    return scope.run({ userId }, () => PATCH(request, { params: Promise.resolve({ id: 'job-1' }) }))
  }

  function invokeDelete(userId: string) {
    const request = new NextRequest('http://localhost/api/jobs/job-1', { method: 'DELETE' })
    return scope.run({ userId }, () => DELETE(request, { params: Promise.resolve({ id: 'job-1' }) }))
  }

  function holdFence(userId: string) {
    const acquired = deferred<void>()
    const release = deferred<void>()
    const transaction = clientA.$transaction(async tx => {
      await acquireSourceMaterialFence(tx, [userId])
      acquired.resolve()
      await release.promise
    })
    return { acquired: acquired.promise, release: () => release.resolve(), transaction }
  }

  async function seed(owner: string, description: string | null = null) {
    await clientA.job.create({
      data: { id: 'job-1', userId: owner, company: 'Fixture', role: 'Engineer', description, notes: 'preserve me' },
    })
  }

  it('holds the same-user fence through conditional description PATCH commit', async () => {
    await seed('owner-a')
    const holder = holdFence('owner-a')
    let request: ReturnType<typeof invokePatch> | undefined
    try {
      await within(holder.acquired)
      request = invokePatch('owner-a', 'Updated description', null)
      await expectBlocked(request)
      expect((await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })).description).toBeNull()
      holder.release()
      expect((await within(request)).status).toBe(200)
      const row = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(row.description).toBe('Updated description')
      expect(row.notes).toBe('preserve me')
    } finally {
      holder.release()
      await within(Promise.allSettled(request ? [holder.transaction, request] : [holder.transaction]))
    }
  }, 25_000)

  it.each([null, '', ' \t\n '])('serializes two conditional description PATCH requests with one winner for %j', async expected => {
    await seed('owner-a', expected)
    const first = invokePatch('owner-a', 'Description A', expected)
    const second = invokePatch('owner-a', 'Description B', expected)

    const responses = await within(Promise.all([first, second]))

    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const winningResponse = responses.find(response => response.status === 200)
    if (!winningResponse) throw new Error('Expected one conditional description PATCH winner')
    const winner = await winningResponse.json() as { description: string }
    const row = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
    expect(row.description).toBe(winner.description)
    expect(row.userId).toBe('owner-a')
    expect(row.notes).toBe('preserve me')
  }, 25_000)

  it('rejects an owner change committed after the scoped read and before conditional update', async () => {
    await seed('owner-a')
    const rowLocked = deferred<void>()
    const allowOwnerChange = deferred<void>()
    const blocker = clientA.$transaction(async tx => {
      await tx.job.update({ where: { id: 'job-1' }, data: { notes: 'owner transfer in progress' } })
      rowLocked.resolve()
      await allowOwnerChange.promise
      await tx.job.update({ where: { id: 'job-1' }, data: { userId: 'owner-b' } })
    })
    let request: ReturnType<typeof invokePatch> | undefined
    try {
      await within(rowLocked.promise)
      request = invokePatch('owner-a', 'Must not be saved', null)
      await waitForDatabaseLockWait(admin)
      allowOwnerChange.resolve()
      expect((await within(request)).status).toBe(409)
      const row = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(row.userId).toBe('owner-b')
      expect(row.description).toBeNull()
      expect(row.notes).toBe('owner transfer in progress')
      const retry = await within(invokePatch('owner-a', 'Still not saved', null))
      expect(retry.status).toBe(404)
      const afterRetry = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(afterRetry.userId).toBe('owner-b')
      expect(afterRetry.description).toBeNull()
      expect(afterRetry.notes).toBe('owner transfer in progress')
    } finally {
      allowOwnerChange.resolve()
      await within(Promise.allSettled(request ? [blocker, request] : [blocker]))
    }
  }, 25_000)

  it('holds the same-user fence through DELETE commit and keeps tenant isolation', async () => {
    await seed('owner-a')
    const holder = holdFence('owner-a')
    let request: ReturnType<typeof invokeDelete> | undefined
    try {
      await within(holder.acquired)
      request = invokeDelete('owner-a')
      await expectBlocked(request)
      expect(await clientB.job.findUnique({ where: { id: 'job-1' } })).not.toBeNull()
      holder.release()
      expect((await within(request)).status).toBe(200)
      expect(await clientB.job.findUnique({ where: { id: 'job-1' } })).toBeNull()
    } finally {
      holder.release()
      await within(Promise.allSettled(request ? [holder.transaction, request] : [holder.transaction]))
    }
  }, 25_000)

  it('returns 404 and leaves another tenant job unchanged', async () => {
    await seed('owner-b')

    const response = await within(invokeDelete('owner-a'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Not found' })
    expect((await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })).userId).toBe('owner-b')
  })
})
