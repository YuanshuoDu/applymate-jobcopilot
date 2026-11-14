import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// This opt-in test only accepts an explicitly named, disposable loopback DB.
// No existing application database or migrations are touched.
const configuredUrl = process.env.DESCRIPTION_CAS_PG_TEST_URL
const disposable = process.env.DESCRIPTION_CAS_PG_TEST_DISPOSABLE
const enabled = Boolean(configuredUrl || disposable)
if (enabled) {
  let parsed: URL
  try { parsed = new URL(configuredUrl ?? '') } catch { throw new Error('Invalid disposable description CAS test configuration') }
  if (disposable !== 'true' || !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/applymate_description_cas_test'
    || !parsed.username || parsed.search || parsed.hash) {
    throw new Error('Description CAS integration requires the explicitly marked disposable loopback database')
  }
}

type Barrier = { arrive: () => void; wait: Promise<void> }
type RequestScope = { client: PrismaClient; userId: string; barrier?: Barrier }
const scope = new AsyncLocalStorage<RequestScope>()
function currentScope(): RequestScope {
  const current = scope.getStore()
  if (!current) throw new Error('Missing test request scope')
  return current
}
function barrierFor(count: number) {
  let arrived = 0
  let signalReached: () => void = () => {}
  let release: () => void = () => {}
  const reached = new Promise<void>(resolve => { signalReached = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  return { reached, release, barrier: { arrive: () => { if (++arrived === count) signalReached() }, wait } }
}
async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Description CAS test timed out')), ms) })])
  } finally { if (timeout) clearTimeout(timeout) }
}

const integration = enabled ? describe : describe.skip
integration('conditional job description PATCH with PostgreSQL', () => {
  let admin: PrismaClient
  let clientA: PrismaClient
  let clientB: PrismaClient
  let schemaCreated = false
  let PATCH: typeof import('./route').PATCH
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
    // findUnique returns all scalar fields, so this mirrors the complete Job
    // scalar shape; relationships and unrelated tables are intentionally absent.
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
    vi.doMock('@/lib/api-helpers', () => ({
      requireAuth: async () => ({ userId: currentScope().userId }),
      isErrorResponse: (value: unknown) => value instanceof Response,
      ok: (value: unknown, status = 200) => Response.json(value, { status }),
      err: (message: string, status = 400) => Response.json({ error: message }, { status }),
    }))
    // The route runs unchanged. Only authentication and the wrapper that pauses
    // after the real ownership read are instrumented; Prisma writes are real.
    // Load the real database module only after redirecting it to this isolated
    // schema. Never reuse a global Prisma singleton from another test.
    if ((globalThis as unknown as { prisma?: unknown }).prisma || process.env.RLS_RUNTIME_MODE === 'on') {
      throw new Error('Description CAS test requires an isolated Prisma runtime with RLS disabled')
    }
    process.env.DATABASE_URL = schemaUrl.toString()
    routeDb = (await import('@/lib/db')).db
    ownsGlobalPrisma = Boolean((globalThis as unknown as { prisma?: unknown }).prisma)
    const delegate = routeDb.job
    // Spies only coordinate the two real clients and reads. No query is faked:
    // each operation invokes the real generated Prisma delegate for its scope.
    vi.spyOn(delegate, 'findUnique').mockImplementation((async (args: Prisma.JobFindUniqueArgs) => {
      const request = currentScope()
      const row = await request.client.job.findUnique(args)
      if (request.barrier) { request.barrier.arrive(); await request.barrier.wait }
      return row
    }) as unknown as typeof delegate.findUnique)
    vi.spyOn(delegate, 'updateMany').mockImplementation(((args: Prisma.JobUpdateManyArgs) =>
      currentScope().client.job.updateMany(args)) as unknown as typeof delegate.updateMany)
    PATCH = (await import('./route')).PATCH
  }, 30_000)

  beforeEach(async () => {
    await clientA.job.deleteMany()
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    vi.doUnmock('@/lib/api-helpers')
    await routeDb?.$disconnect()
    if (ownsGlobalPrisma) delete (globalThis as unknown as { prisma?: unknown }).prisma
    vi.resetModules()
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalDatabaseUrl
    await clientA?.$disconnect()
    await clientB?.$disconnect()
    // schema is generated locally from hex and only the validated DB is used.
    if (schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
    await admin?.$disconnect()
  }, 30_000)

  function invoke(client: PrismaClient, userId: string, description: string, expected: string | null, barrier?: Barrier) {
    const req = new NextRequest('http://localhost/api/jobs/job-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description, expectedEmptyDescription: expected }),
    })
    return scope.run({ client, userId, barrier }, () => PATCH(req, { params: Promise.resolve({ id: 'job-1' }) }))
  }
  async function seed(description: string | null) {
    await clientA.job.create({ data: { id: 'job-1', userId: 'owner-a', company: 'Fixture', role: 'Engineer', description, notes: 'preserve me' } })
  }

  it.each([null, '', ' \t\n '])('allows one winner against exact original value %j', async expected => {
    await seed(expected)
    const gate = barrierFor(2)
    const first = invoke(clientA, 'owner-a', 'Description A', expected, gate.barrier)
    const second = invoke(clientB, 'owner-a', 'Description B', expected, gate.barrier)
    try {
      await within(gate.reached)
      gate.release()
      const responses = await within(Promise.all([first, second]))
      expect(responses.map(response => response.status).sort()).toEqual([200, 409])
      const winner = responses[0].status === 200 ? 'Description A' : 'Description B'
      const row = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(row.description).toBe(winner)
      expect(row.userId).toBe('owner-a')
      expect(row.notes).toBe('preserve me')
    } finally { gate.release(); await within(Promise.allSettled([first, second])) }
  }, 25_000)

  it('rejects the original owner when ownership changes after the real read', async () => {
    await seed(null)
    const gate = barrierFor(1)
    const request = invoke(clientA, 'owner-a', 'Should not be saved', null, gate.barrier)
    try {
      await within(gate.reached)
      await clientB.job.updateMany({ where: { id: 'job-1', userId: 'owner-a' }, data: { userId: 'owner-b' } })
      gate.release()
      expect((await within(request)).status).toBe(409)
      const row = await clientB.job.findUniqueOrThrow({ where: { id: 'job-1' } })
      expect(row.userId).toBe('owner-b')
      expect(row.description).toBeNull()
      expect(row.notes).toBe('preserve me')
      expect((await invoke(clientA, 'owner-a', 'Still not saved', null)).status).toBe(404)
    } finally { gate.release(); await within(Promise.allSettled([request])) }
  }, 25_000)
})
