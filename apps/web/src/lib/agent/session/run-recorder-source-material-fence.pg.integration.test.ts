import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient, type Prisma } from "@prisma/client"
import { acquireSourceMaterialFence } from "../source-material-fence"
import { withRunRecorderWriteOwnership } from "./run-recorder-ownership"

const EXPECTED_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci"
const WAIT_TIMEOUT_MS = 8_000
const TEST_TIMEOUT_MS = 35_000

type OwnerFixture = { userId: string; sessionId: string; turnId: string; executionId: string; jobId: string }

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  const requested = value !== undefined
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== undefined
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== undefined
  if (!value) {
    if (requested) throw new Error("Prepare status fence tests require the fixed disposable PostgreSQL service URL")
    return null
  }

  let url: URL
  try { url = new URL(value) } catch {
    throw new Error("Prepare status fence tests require the fixed disposable PostgreSQL service URL")
  }
  if (value !== EXPECTED_DATABASE_URL
    || process.env.DATABASE_URL !== EXPECTED_DATABASE_URL
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== "/applymate_agent_brain_ci"
    || url.search
    || url.hash) {
    throw new Error("Prepare status fence tests require the fixed disposable PostgreSQL service URL")
  }
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
let prisma: PrismaClient | undefined
const ownerIds = new Set<string>()

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(description)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForAdvisoryLockWait(writerSettled: () => boolean): Promise<void> {
  const client = prisma!
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (writerSettled()) throw new Error("Same-user status writer completed before the source fence was released")
    const rows = await client.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%pg_advisory_xact_lock%'
      ) AS waiting
    `
    if (rows[0]?.waiting) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for the same-user source fence")
}

async function createOwner(client: PrismaClient): Promise<OwnerFixture> {
  const suffix = randomUUID()
  const fixture: OwnerFixture = {
    userId: `source-fence-user-${suffix}`,
    sessionId: `source-fence-session-${suffix}`,
    turnId: `source-fence-turn-${suffix}`,
    executionId: `source-fence-execution-${suffix}`,
    jobId: `source-fence-job-${suffix}`,
  }
  ownerIds.add(fixture.userId)
  await client.user.create({ data: { id: fixture.userId, email: `${fixture.userId}@example.invalid`, onboardingGoals: [] } })
  await client.agentSession.create({ data: {
    id: fixture.sessionId, userId: fixture.userId, goal: "Prepare pending jobs", status: "running", source: "automation",
  } })
  await client.agentTurn.create({ data: {
    id: fixture.turnId, sessionId: fixture.sessionId, userId: fixture.userId, source: "automation", status: "in_progress",
    input: {}, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
  } })
  await client.agentExecution.create({ data: {
    id: fixture.executionId, userId: fixture.userId, sessionId: fixture.sessionId,
    status: "running", checkpoint: "gate", attemptCount: 1,
  } })
  await client.job.create({ data: {
    id: fixture.jobId, userId: fixture.userId, company: "Fence Fixture", role: "Pending review", status: "applied",
  } })
  return fixture
}

function writePendingStatus(fixture: OwnerFixture) {
  return withRunRecorderWriteOwnership(prisma as never, {
    sessionId: fixture.sessionId,
    userId: fixture.userId,
    requireSourceMaterialFence: true,
    owner: {
      turnId: fixture.turnId,
      executionAttempt: { id: fixture.executionId, attemptCount: 1 },
      requireRunning: true,
    },
  }, async tx => (tx as unknown as Prisma.TransactionClient).job.update({
    where: { id: fixture.jobId },
    data: { status: "saved", workflowState: "ready_to_apply" },
  }))
}

describeWithPostgres("Prepare pending Job.status source-fence transaction", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await prisma.$connect()
  })

  afterEach(async () => {
    if (!prisma) return
    for (const userId of ownerIds) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
    ownerIds.clear()
  })

  afterAll(async () => { await prisma?.$disconnect() })

  it("keeps a pending status write outside the final material read-to-commit window and isolates users", async () => {
    const client = prisma!
    const owner = await createOwner(client)
    const otherOwner = await createOwner(client)
    const finalMaterialRead = deferred<string>()
    const releaseCommit = deferred<void>()
    const terminalizer = client.$transaction(async tx => {
      await acquireSourceMaterialFence(tx, [owner.userId])
      const job = await tx.job.findUnique({ where: { id: owner.jobId }, select: { status: true } })
      if (!job) throw new Error("Prepare source fixture is missing")
      finalMaterialRead.resolve(job.status)
      await releaseCommit.promise
      return job.status
    }, { maxWait: WAIT_TIMEOUT_MS, timeout: TEST_TIMEOUT_MS })
    const terminalizerOutcome = terminalizer.then(
      value => ({ kind: "committed" as const, value }),
      error => ({ kind: "rolled_back" as const, error }),
    )
    await expect(withTimeout(finalMaterialRead.promise, "Final material read was not reached")).resolves.toBe("applied")

    let sameUserWriterSettled = false
    const sameUserWriter = writePendingStatus(owner).then(
      value => { sameUserWriterSettled = true; return { ok: true as const, value } },
      error => { sameUserWriterSettled = true; return { ok: false as const, error } },
    )
    try {
      await waitForAdvisoryLockWait(() => sameUserWriterSettled)
      await expect(withTimeout(writePendingStatus(otherOwner), "Different-user status write was blocked")).resolves.toMatchObject({ owned: true })
      releaseCommit.resolve(undefined)
      await expect(withTimeout(terminalizerOutcome, "Material transaction did not commit")).resolves.toMatchObject({ kind: "committed", value: "applied" })
      const writerOutcome = await withTimeout(sameUserWriter, "Same-user status writer did not resume after commit")
      expect(writerOutcome.ok).toBe(true)
      await expect(client.job.findUnique({ where: { id: owner.jobId }, select: { status: true } })).resolves.toEqual({ status: "saved" })
    } finally {
      releaseCommit.resolve(undefined)
      await withTimeout(Promise.all([terminalizerOutcome, sameUserWriter]), "Committed barrier cleanup did not settle").catch(() => undefined)
    }
  }, TEST_TIMEOUT_MS)

  it("releases the same-user pending status writer when the material transaction rolls back", async () => {
    const client = prisma!
    const owner = await createOwner(client)
    const finalMaterialRead = deferred<string>()
    const releaseRollback = deferred<void>()
    const terminalizer = client.$transaction(async tx => {
      await acquireSourceMaterialFence(tx, [owner.userId])
      const job = await tx.job.findUnique({ where: { id: owner.jobId }, select: { status: true } })
      if (!job) throw new Error("Prepare source fixture is missing")
      finalMaterialRead.resolve(job.status)
      await releaseRollback.promise
      throw new Error("intentional disposable transaction rollback")
    }, { maxWait: WAIT_TIMEOUT_MS, timeout: TEST_TIMEOUT_MS })
    const terminalizerOutcome = terminalizer.then(
      value => ({ kind: "committed" as const, value }),
      error => ({ kind: "rolled_back" as const, error }),
    )
    await expect(withTimeout(finalMaterialRead.promise, "Final material read was not reached")).resolves.toBe("applied")

    let writerSettled = false
    const writer = writePendingStatus(owner).then(
      value => { writerSettled = true; return { ok: true as const, value } },
      error => { writerSettled = true; return { ok: false as const, error } },
    )
    try {
      await waitForAdvisoryLockWait(() => writerSettled)
      releaseRollback.resolve(undefined)
      await expect(withTimeout(terminalizerOutcome, "Material transaction did not roll back")).resolves.toMatchObject({ kind: "rolled_back" })
      const writerOutcome = await withTimeout(writer, "Status writer did not resume after rollback")
      expect(writerOutcome.ok).toBe(true)
      await expect(client.job.findUnique({ where: { id: owner.jobId }, select: { status: true } })).resolves.toEqual({ status: "saved" })
    } finally {
      releaseRollback.resolve(undefined)
      await withTimeout(Promise.all([terminalizerOutcome, writer]), "Rollback barrier cleanup did not settle").catch(() => undefined)
    }
  }, TEST_TIMEOUT_MS)
})
