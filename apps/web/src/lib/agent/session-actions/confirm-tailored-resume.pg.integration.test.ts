import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'
import { confirmTailoredResumeSourceWrite } from './confirm-tailored-resume'

const configuredUrl = process.env.CONFIRM_TAILORED_RESUME_PG_TEST_URL
const disposable = process.env.CONFIRM_TAILORED_RESUME_PG_TEST_DISPOSABLE
const required = process.env.CONFIRM_TAILORED_RESUME_PG_TEST_REQUIRED
const enabled = Boolean(configuredUrl || disposable || required)
if (required === 'true' && !configuredUrl) throw new Error('Confirmed tailored-resume PostgreSQL test requires its dedicated disposable database URL')
if (enabled) {
  let parsed: URL
  try { parsed = new URL(configuredUrl ?? '') } catch { throw new Error('Invalid confirmed tailored-resume PostgreSQL test URL') }
  if (disposable !== 'true' || !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.hostname !== '127.0.0.1' || parsed.port !== '5432'
    || parsed.username !== 'postgres' || parsed.password !== 'postgres'
    || parsed.pathname !== '/applymate_confirm_tailored_resume_ci' || parsed.search || parsed.hash) {
    throw new Error('Confirmed tailored-resume PostgreSQL test accepts only its dedicated loopback disposable database')
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Confirmed tailored-resume PostgreSQL test timed out')), ms)
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
    const rows = await admin.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND datname = current_database() AND wait_event_type = 'Lock'
    `
    if ((rows[0]?.count ?? 0) > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Competing source writer did not reach the expected source-fence lock wait')
}

const integration = enabled ? describe : describe.skip
integration('confirmed tailored-resume source write with disposable PostgreSQL', () => {
  let admin: PrismaClient
  let clientA: PrismaClient
  let clientB: PrismaClient
  let schemaCreated = false
  const schema = `confirm_resume_${randomBytes(12).toString('hex')}`

  beforeAll(async () => {
    // Guard validation runs above before creating a client or issuing SQL.
    admin = new PrismaClient({ datasources: { db: { url: configuredUrl! } } })
    await admin.$connect()
    const existing = await admin.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'
    `
    if ((existing[0]?.count ?? 0) !== 0) throw new Error('Expected the dedicated confirmed tailored-resume database to be empty')

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
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "company" TEXT NOT NULL, "role" TEXT NOT NULL,
      "url" TEXT, "status" "${schema}"."JobStatus" NOT NULL DEFAULT 'saved',
      "workflowState" "${schema}"."JobWorkflowState" NOT NULL DEFAULT 'draft',
      "analysisNote" TEXT, "finalResumeId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await clientA.$executeRawUnsafe(`CREATE TABLE "${schema}"."Resume" (
      "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "targetJobId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
  }, 30_000)

  beforeEach(async () => {
    await clientA.$executeRaw`TRUNCATE TABLE "Resume", "Job"`
    await clientA.$executeRaw`INSERT INTO "Job" ("id", "userId", "company", "role", "url", "status") VALUES ('job-1', 'owner-a', 'Acme', 'Engineer', 'https://jobs.example/apply', 'interview')`
    await clientA.$executeRaw`INSERT INTO "Resume" ("id", "userId", "name", "targetJobId") VALUES ('resume-1', 'owner-a', 'Tailored Resume', 'job-1')`
  })

  afterAll(async () => {
    await clientA?.$disconnect()
    await clientB?.$disconnect()
    if (schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
    await admin?.$disconnect()
  }, 30_000)

  it.each([{ rollback: false }, { rollback: true }])('holds the source fence until the Job write transaction ends (rollback=$rollback)', async ({ rollback }) => {
    const written = deferred<Awaited<ReturnType<typeof confirmTailoredResumeSourceWrite>>>()
    const finish = deferred<void>()
    const confirmation = clientA.$transaction(async tx => {
      const result = await confirmTailoredResumeSourceWrite(tx, 'owner-a', { jobId: 'job-1', resumeId: 'resume-1' })
      written.resolve(result)
      await finish.promise
      if (rollback) throw new Error('forced rollback after source write')
      return result
    })
    let sourceWriter: Promise<unknown> | undefined
    try {
      await expect(within(written.promise)).resolves.toMatchObject({ kind: 'saved' })
      sourceWriter = clientB.$transaction(async tx => {
        await acquireSourceMaterialFence(tx, ['owner-a'])
        return tx.resume.updateMany({ where: { id: 'resume-1', userId: 'owner-a' }, data: { name: 'Concurrent source update' } })
      })
      await waitForDatabaseLockWait(admin)
      await expectBlocked(sourceWriter)
      expect(await clientB.job.findFirst({ where: { id: 'job-1', userId: 'owner-a' }, select: { status: true } })).toEqual({ status: 'interview' })

      finish.resolve()
      if (rollback) await expect(within(confirmation)).rejects.toThrow('forced rollback after source write')
      else await expect(within(confirmation)).resolves.toMatchObject({ kind: 'saved' })
      await within(sourceWriter)

      const job = await clientB.job.findFirst({ where: { id: 'job-1', userId: 'owner-a' }, select: { status: true, finalResumeId: true } })
      const resume = await clientB.resume.findFirst({ where: { id: 'resume-1', userId: 'owner-a' }, select: { name: true } })
      expect(job).toEqual(rollback ? { status: 'interview', finalResumeId: null } : { status: 'saved', finalResumeId: 'resume-1' })
      expect(resume).toEqual({ name: 'Concurrent source update' })
    } finally {
      finish.resolve()
      await within(Promise.allSettled([confirmation, ...(sourceWriter ? [sourceWriter] : [])]))
    }
  }, 25_000)
})
