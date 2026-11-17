import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool, type PoolClient } from "pg"

// Worker Vitest aliases this test-only Web import to apps/web/src.
// @ts-expect-error The Worker TypeScript project does not compile Web path aliases.
import { acquireSourceMaterialFence as acquireWebSourceMaterialFence } from "@/lib/agent/source-material-fence"
import { acquireSourceMaterialFence as acquireWorkerSourceMaterialFence } from "./source-material-fence.js"
import { updateJobForSubmission } from "./submission-guard.js"
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js"
import { createAgentArtifactRepository, type AgentArtifactBaseInsert } from "./agent-artifact-repo.js"
import { persistLegacyApplicationTaskOutcome, writeLegacyFillErrorOutcome } from "./legacy-application-task-outcome.js"

type PrismaRawClient = {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
}
type WebPrismaClient = PrismaRawClient & {
  $connect(): Promise<void>
  $disconnect(): Promise<void>
  $transaction<T>(
    callback: (transaction: PrismaRawClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>
}
type WebSourceMaterialFence = (transaction: unknown, userIds: readonly string[]) => Promise<void>

const webRequire = createRequire(new URL("../../../web/package.json", import.meta.url))
const PrismaClient = (webRequire("@prisma/client") as {
  PrismaClient: new (options: { datasources: { db: { url: string } } }) => WebPrismaClient
}).PrismaClient
const acquireWebFence = acquireWebSourceMaterialFence as unknown as WebSourceMaterialFence

const EXPECTED_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci"
const WAIT_TIMEOUT_MS = 8_000
const CLEANUP_TIMEOUT_MS = 4_000
const TEST_TIMEOUT_MS = 30_000
const TRANSACTION_ERROR = "source material fence transaction verification failed"

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  const requested = value !== undefined
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== undefined
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== undefined
  if (!value) {
    if (requested) throw new Error("Source material fence tests require the fixed disposable PostgreSQL service URL")
    return null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Source material fence tests require the fixed disposable PostgreSQL service URL")
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
    throw new Error("Source material fence tests require the fixed disposable PostgreSQL service URL")
  }
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
let prisma: WebPrismaClient | undefined
let pool: Pool | undefined

function runWebTransaction<T>(callback: (transaction: PrismaRawClient) => Promise<T>): Promise<T> {
  return prisma!.$transaction(callback, { maxWait: WAIT_TIMEOUT_MS, timeout: WAIT_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + 2_000 })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function withTimeout<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function completesWithin(promise: Promise<unknown>, description: string, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<boolean> {
  try {
    await withTimeout(promise, description, timeoutMs)
    return true
  } catch {
    return false
  }
}

async function settleOperations(...operations: Array<Promise<unknown> | undefined>): Promise<boolean> {
  const pending = operations.filter((operation): operation is Promise<unknown> => operation !== undefined)
  return completesWithin(Promise.allSettled(pending), "Source material fence test operations did not settle")
}

async function rollbackAndReleaseWorkerClient(client: PoolClient, transactionOpen: boolean): Promise<void> {
  if (transactionOpen) {
    const rolledBack = await completesWithin(client.query("ROLLBACK"), "Worker rollback timed out")
    if (!rolledBack) {
      client.release(new Error("Source material fence test cleanup timed out"))
      return
    }
  }
  client.release()
}

type ArtifactWriterGate = {
  readonly writerPid: ReturnType<typeof deferred<number>>
  readonly artifactInsertReached: ReturnType<typeof deferred<void>>
  readonly commitReached: ReturnType<typeof deferred<void>>
  readonly releaseCommit: ReturnType<typeof deferred<void>>
  readonly rollbackReached: ReturnType<typeof deferred<void>>
  readonly releaseRollback: ReturnType<typeof deferred<void>>
  readonly failCommit: boolean
  readonly holdRollback: boolean
  forceReleaseWriterClient?: (error: Error) => void
}

function createArtifactWriterGate(options: { failCommit: boolean; holdRollback: boolean }): ArtifactWriterGate {
  return {
    writerPid: deferred<number>(),
    artifactInsertReached: deferred<void>(),
    commitReached: deferred<void>(),
    releaseCommit: deferred<void>(),
    rollbackReached: deferred<void>(),
    releaseRollback: deferred<void>(),
    failCommit: options.failCommit,
    holdRollback: options.holdRollback,
  }
}

/** Pauses the real repository transaction at terminal SQL; rollback mode fails COMMIT only after the real INSERT. */
function withArtifactWriterGate(basePool: Pool, gate: ArtifactWriterGate): Pool {
  return {
    async connect() {
      const client = await basePool.connect()
      const query = client.query.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>
      let released = false
      const release = (error?: Error): void => {
        if (released) return
        released = true
        if (error) client.release(error)
        else client.release()
      }
      gate.forceReleaseWriterClient = release

      const gatedClient = {
        async query(...args: unknown[]): Promise<unknown> {
          const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : ""
          if (sql === "BEGIN") {
            const result = await query(...args)
            const pidResult = await query("SELECT pg_backend_pid()::int AS pid") as { rows: Array<{ pid: unknown }> }
            const pid = pidResult.rows[0]?.pid
            if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
              throw new Error("Could not read the artifact writer backend PID")
            }
            gate.writerPid.resolve(pid)
            return result
          }
          if (sql === "COMMIT") {
            gate.commitReached.resolve(undefined)
            await gate.releaseCommit.promise
            if (gate.failCommit) throw new Error("Injected disposable artifact commit failure")
          }
          if (sql === "ROLLBACK" && gate.holdRollback) {
            gate.rollbackReached.resolve(undefined)
            await gate.releaseRollback.promise
          }
          const result = await query(...args)
          if (sql.startsWith('INSERT INTO "AGENT_ARTIFACT"')) gate.artifactInsertReached.resolve(undefined)
          return result
        },
        release,
      }
      return gatedClient as unknown as PoolClient
    },
  } as unknown as Pool
}

function sourceArtifactBase(userId: string, jobId: string, artifactId: string): AgentArtifactBaseInsert {
  return {
    id: artifactId,
    userId,
    jobId,
    artifactType: "resume",
    content: { source: "disposable-source-material-fence" },
    hash: `sha256:${"a".repeat(64)}`,
    constraintHash: `sha256:${"b".repeat(64)}`,
    provenanceRefs: [],
    evidenceRefs: [],
  }
}

function startWebFenceWaiter(userId: string) {
  const backendPid = deferred<number>()
  const acquired = deferred<void>()
  let settled = false
  const transaction = runWebTransaction(async tx => {
    backendPid.resolve(await prismaBackendPid(tx))
    await acquireWebFence(tx, [userId])
    acquired.resolve(undefined)
  })
  void transaction.then(() => { settled = true }, () => { settled = true })
  return { backendPid: backendPid.promise, acquired: acquired.promise, transaction, isSettled: () => settled }
}

async function cleanArtifactRow(artifactId: string, userId: string): Promise<void> {
  const deleted = await completesWithin(
    pool!.query('DELETE FROM "agent_artifact" WHERE "id" = $1 AND "userId" = $2', [artifactId, userId]),
    "Disposable artifact cleanup timed out",
  )
  if (!deleted) throw new Error("Disposable artifact cleanup did not finish")
}

async function cleanupArtifactWriterCase(
  gate: ArtifactWriterGate,
  writerOperation: Promise<unknown> | undefined,
  webTransaction: Promise<void> | undefined,
  artifactId: string,
  userId: string,
): Promise<void> {
  gate.releaseCommit.resolve(undefined)
  gate.releaseRollback.resolve(undefined)
  const settled = await settleOperations(writerOperation, webTransaction)
  if (!settled) {
    gate.forceReleaseWriterClient?.(new Error("Source material fence writer cleanup timed out"))
    const pending: Promise<boolean>[] = []
    if (writerOperation) pending.push(completesWithin(writerOperation, "Artifact writer cleanup timed out"))
    if (webTransaction) pending.push(completesWithin(webTransaction, "Web fence cleanup timed out"))
    await Promise.all(pending)
  }
  await cleanArtifactRow(artifactId, userId)
}

async function prismaBackendPid(client: PrismaRawClient): Promise<number> {
  const rows = await withTimeout(
    client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    "Prisma backend PID query timed out",
  )
  const pid = rows[0]?.pid
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Could not read the disposable PostgreSQL backend PID")
  return pid
}

async function workerBackendPid(client: PoolClient): Promise<number> {
  const result = await withTimeout(
    client.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"),
    "Worker backend PID query timed out",
  )
  const pid = result.rows[0]?.pid
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Could not read the disposable PostgreSQL backend PID")
  return pid
}

async function blockingPids(waiterPid: number): Promise<number[]> {
  const result = await withTimeout(
    pool!.query<{ pids: number[] }>("SELECT pg_blocking_pids($1::int) AS pids", [waiterPid]),
    "PostgreSQL blocker probe timed out",
  )
  const pids = result.rows[0]?.pids
  if (!Array.isArray(pids)) throw new Error("Could not inspect disposable PostgreSQL lock waiters")
  return pids
}

async function waitForBlocker(waiterPid: number, blockerPid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await blockingPids(waiterPid)).includes(blockerPid)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for the source material advisory lock")
}

describeWithPostgres("Web Prisma and Worker pg source material fence", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    pool = new Pool({
      connectionString: databaseUrl!,
      max: 4,
      connectionTimeoutMillis: WAIT_TIMEOUT_MS,
      query_timeout: WAIT_TIMEOUT_MS,
      statement_timeout: WAIT_TIMEOUT_MS,
    })
    await Promise.all([
      withTimeout(prisma.$connect(), "Prisma connection timed out"),
      withTimeout(pool.query("SELECT 1"), "Worker PostgreSQL connection timed out"),
    ])
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    const cleanup = [prisma?.$disconnect(), pool?.end()]
      .filter((operation): operation is Promise<void> => operation !== undefined)
    const closed = await completesWithin(Promise.allSettled(cleanup), "PostgreSQL clients did not close")
    if (!closed) throw new Error("PostgreSQL client cleanup timed out")
  }, CLEANUP_TIMEOUT_MS + 1_000)

  afterEach(() => vi.restoreAllMocks())

  it("holds a Web lock against Worker acquisition until Web commit", async () => {
    const userId = `source-fence-${randomUUID()}`
    const webReady = deferred<number>()
    const releaseWeb = deferred<void>()
    let webTransaction: Promise<void> | undefined
    let workerAcquisition: Promise<void> | undefined
    let workerClient: PoolClient | undefined
    let workerTransactionOpen = false

    try {
      webTransaction = runWebTransaction(async tx => {
        await acquireWebFence(tx, [userId])
        webReady.resolve(await prismaBackendPid(tx))
        await releaseWeb.promise
      })
      const webPid = await withTimeout(webReady.promise, "Web transaction did not acquire its source material lock")
      workerClient = await pool!.connect()
      workerTransactionOpen = true
      await withTimeout(workerClient.query("BEGIN"), "Worker transaction begin timed out")
      const workerPid = await workerBackendPid(workerClient)
      let workerSettled = false
      workerAcquisition = acquireWorkerSourceMaterialFence(workerClient, [userId])
      void workerAcquisition.then(() => { workerSettled = true }, () => { workerSettled = true })

      await waitForBlocker(workerPid, webPid)
      expect(workerSettled).toBe(false)

      releaseWeb.resolve(undefined)
      await withTimeout(webTransaction, "Web transaction did not commit", CLEANUP_TIMEOUT_MS)
      await withTimeout(workerAcquisition, "Worker did not acquire after Web commit", CLEANUP_TIMEOUT_MS)
      await withTimeout(workerClient.query("COMMIT"), "Worker transaction commit timed out")
      workerTransactionOpen = false
    } finally {
      releaseWeb.resolve(undefined)
      const settled = await settleOperations(webTransaction, workerAcquisition)
      if (!settled && workerClient) {
        workerClient.release(new Error("Source material fence test cleanup timed out"))
        workerClient = undefined
      }
      if (!settled) {
        if (webTransaction) await completesWithin(webTransaction, "Web transaction cleanup timed out")
        if (workerAcquisition) await completesWithin(workerAcquisition, "Worker acquisition cleanup timed out")
      }
      if (workerClient) await rollbackAndReleaseWorkerClient(workerClient, workerTransactionOpen)
    }
  }, TEST_TIMEOUT_MS)

  it("releases a Worker lock after rollback so a Web transaction can proceed", async () => {
    const userId = `source-fence-${randomUUID()}`
    const webPidReady = deferred<number>()
    const webAcquired = deferred<void>()
    let webTransaction: Promise<void> | undefined
    let workerClient: PoolClient | undefined
    let workerTransactionOpen = false

    try {
      workerClient = await pool!.connect()
      workerTransactionOpen = true
      await withTimeout(workerClient.query("BEGIN"), "Worker transaction begin timed out")
      await acquireWorkerSourceMaterialFence(workerClient, [userId])
      const workerPid = await workerBackendPid(workerClient)

      webTransaction = runWebTransaction(async tx => {
        webPidReady.resolve(await prismaBackendPid(tx))
        await acquireWebFence(tx, [userId])
        webAcquired.resolve(undefined)
      })
      const webPid = await withTimeout(webPidReady.promise, "Web transaction did not start")
      await waitForBlocker(webPid, workerPid)
      expect(await blockingPids(webPid)).toContain(workerPid)

      await withTimeout(workerClient.query("ROLLBACK"), "Worker transaction rollback timed out")
      workerTransactionOpen = false
      await withTimeout(webAcquired.promise, "Web did not acquire after Worker rollback")
      await withTimeout(webTransaction, "Web transaction did not commit", CLEANUP_TIMEOUT_MS)
    } finally {
      if (workerClient) await rollbackAndReleaseWorkerClient(workerClient, workerTransactionOpen)
      if (webTransaction) await completesWithin(webTransaction, "Web transaction cleanup timed out")
    }
  }, TEST_TIMEOUT_MS)

  it("allows different users to acquire concurrently across adapters", async () => {
    const webUserId = `source-fence-web-${randomUUID()}`
    const workerUserId = `source-fence-worker-${randomUUID()}`
    const webReady = deferred<number>()
    const releaseWeb = deferred<void>()
    let webTransaction: Promise<void> | undefined
    let workerAcquisition: Promise<void> | undefined
    let workerClient: PoolClient | undefined
    let workerTransactionOpen = false

    try {
      webTransaction = runWebTransaction(async tx => {
        await acquireWebFence(tx, [webUserId])
        webReady.resolve(await prismaBackendPid(tx))
        await releaseWeb.promise
      })
      const webPid = await withTimeout(webReady.promise, "Web transaction did not acquire its source material lock")
      workerClient = await pool!.connect()
      workerTransactionOpen = true
      await withTimeout(workerClient.query("BEGIN"), "Worker transaction begin timed out")
      const workerPid = await workerBackendPid(workerClient)

      workerAcquisition = acquireWorkerSourceMaterialFence(workerClient, [workerUserId])
      await withTimeout(workerAcquisition, "Worker was blocked by another user's source material lock")
      expect(await blockingPids(workerPid)).not.toContain(webPid)
      await withTimeout(workerClient.query("COMMIT"), "Worker transaction commit timed out")
      workerTransactionOpen = false
      releaseWeb.resolve(undefined)
      await withTimeout(webTransaction, "Web transaction did not commit", CLEANUP_TIMEOUT_MS)
    } finally {
      releaseWeb.resolve(undefined)
      const settled = await settleOperations(webTransaction, workerAcquisition)
      if (!settled && workerClient) {
        workerClient.release(new Error("Source material fence test cleanup timed out"))
        workerClient = undefined
      }
      if (!settled) {
        if (webTransaction) await completesWithin(webTransaction, "Web transaction cleanup timed out")
        if (workerAcquisition) await completesWithin(workerAcquisition, "Worker acquisition cleanup timed out")
      }
      if (workerClient) await rollbackAndReleaseWorkerClient(workerClient, workerTransactionOpen)
    }
  }, TEST_TIMEOUT_MS)

  it("blocks the canonical legacy Job outcome writer behind the Web user fence until commit", async () => {
    const suffix = randomUUID()
    const userId = `source-fence-legacy-user-${suffix}`
    const userEmail = `${userId}@example.invalid`
    const jobId = `source-fence-legacy-job-${suffix}`
    const taskId = `source-fence-legacy-task-${suffix}`
    const scope = { applicationTaskId: taskId, userId, jobId }
    const webReady = deferred<number>()
    const releaseWeb = deferred<void>()
    let webTransaction: Promise<void> | undefined
    let workerOperation: Promise<{ insertedResult: boolean; taskFinalized: boolean }> | undefined
    let workerClient: PoolClient | undefined
    let workerTransactionOpen = false
    let writerCalled = false

    try {
      await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [userId, userEmail])
      await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "status", "updatedAt")
        VALUES ($1, $2, 'Fence Fixture Co', 'Engineer', 'applied', CURRENT_TIMESTAMP)`, [jobId, userId])
      await pool!.query(`INSERT INTO application_tasks ("id", "userId", "jobId", "status", "checkpoint", "updatedAt")
        VALUES ($1, $2, $3, 'filling', 'browser_active', CURRENT_TIMESTAMP)`, [taskId, userId, jobId])

      webTransaction = runWebTransaction(async tx => {
        await acquireWebFence(tx, [userId])
        webReady.resolve(await prismaBackendPid(tx))
        await releaseWeb.promise
      })
      const webPid = await withTimeout(webReady.promise, "Web transaction did not acquire its source material lock")

      workerClient = await pool!.connect()
      workerTransactionOpen = true
      await withTimeout(workerClient.query("BEGIN"), "Worker transaction begin timed out")
      await withTimeout(workerClient.query("SELECT set_config($1, $2, true)", ["app.user_id", userId]), "Worker user scope setup timed out")
      const workerPid = await workerBackendPid(workerClient)
      workerOperation = (async () => {
        const outcome = await persistLegacyApplicationTaskOutcome(workerClient!, scope, client => {
          writerCalled = true
          return writeLegacyFillErrorOutcome(client, scope, {
            result: { userId, jobId, status: "failed", error: "Fixture outcome", durationMs: 0 },
            shouldInsertResult: false,
            browserAttemptStarted: false,
            applicationTaskFinalized: true,
          })
        })
        if (outcome.status !== "persisted") throw new Error(`Legacy fixture outcome was ${outcome.status}`)
        await withTimeout(workerClient!.query("COMMIT"), "Worker transaction commit timed out")
        workerTransactionOpen = false
        return outcome.value
      })()

      await waitForBlocker(workerPid, webPid)
      expect(writerCalled).toBe(false)

      releaseWeb.resolve(undefined)
      await withTimeout(webTransaction, "Web source fence transaction did not commit", CLEANUP_TIMEOUT_MS)
      await expect(withTimeout(workerOperation, "Worker legacy outcome did not finish", CLEANUP_TIMEOUT_MS))
        .resolves.toEqual({ insertedResult: false, taskFinalized: false })
      expect(writerCalled).toBe(true)

      const persisted = await withTimeout(
        pool!.query<{ status: string }>(`SELECT "status" FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [jobId, userId]),
        "Legacy Job status readback timed out",
      )
      expect(persisted.rows).toEqual([{ status: "saved" }])
    } finally {
      releaseWeb.resolve(undefined)
      const settled = await settleOperations(workerOperation, webTransaction)
      if (!settled && workerClient) {
        workerClient.release(new Error("Source material fence test cleanup timed out"))
        workerClient = undefined
      }
      if (!settled) {
        if (workerOperation) await completesWithin(workerOperation, "Legacy writer cleanup timed out")
        if (webTransaction) await completesWithin(webTransaction, "Web transaction cleanup timed out")
      }
      if (workerClient) await rollbackAndReleaseWorkerClient(workerClient, workerTransactionOpen)
      await pool!.query(`DELETE FROM application_tasks WHERE "id" = $1 AND "userId" = $2`, [taskId, userId])
      await pool!.query(`DELETE FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [jobId, userId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [userId])
    }
  }, TEST_TIMEOUT_MS)

  it("blocks the submission Job status writer behind the Web user fence until commit", async () => {
    const suffix = randomUUID()
    const userId = `source-fence-submit-user-${suffix}`
    const userEmail = `${userId}@example.invalid`
    const jobId = `source-fence-submit-job-${suffix}`
    const sessionId = `source-fence-submit-session-${suffix}`
    const turnId = `source-fence-submit-turn-${suffix}`
    const fillerTaskId = `source-fence-submit-filler-${suffix}`
    const applicationTaskId = `source-fence-submit-task-${suffix}`
    const identity: ApplicationSubmitIdentity = {
      userId, jobId, sessionId, fillTurnId: turnId, applicationTaskId,
      approvalId: `source-fence-submit-approval-${suffix}`, constraintHash: "d".repeat(64),
    }
    const webReady = deferred<number>()
    const releaseWeb = deferred<void>()
    const workerPidReady = deferred<number>()
    let webTransaction: Promise<void> | undefined
    let workerOperation: Promise<unknown> | undefined
    let forceReleaseWorkerClient: ((error: Error) => void) | undefined
    let writerSettled = false

    try {
      await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [userId, userEmail])
      await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "status", "updatedAt")
        VALUES ($1, $2, 'Fence Fixture Co', 'Engineer', 'saved', CURRENT_TIMESTAMP)`, [jobId, userId])
      await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
        VALUES ($1, $2, 'Source fence submission test', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, userId])
      await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
        VALUES ($1, $2, $3, 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [turnId, sessionId, userId])
      await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "updatedAt")
        VALUES ($1, $2, $3, 'application_filler', 'application_fill_for_review', 'completed', 'Source fence test', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
      [fillerTaskId, sessionId, turnId])
      await pool!.query(`INSERT INTO application_tasks ("id", "userId", "jobId", "sessionId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "status", "checkpoint", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $4, $2, 'filling', 'submission_request_started', CURRENT_TIMESTAMP)`,
      [applicationTaskId, userId, jobId, sessionId, turnId])

      webTransaction = runWebTransaction(async tx => {
        await acquireWebFence(tx, [userId])
        webReady.resolve(await prismaBackendPid(tx))
        await releaseWeb.promise
      })
      const webPid = await withTimeout(webReady.promise, "Web transaction did not acquire the submission source fence")

      const workerPool = {
        async connect() {
          const client = await pool!.connect()
          const query = client.query.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>
          let released = false
          const release = (error?: Error) => {
            if (released) return
            released = true
            if (error) client.release(error)
            else client.release()
          }
          forceReleaseWorkerClient = release
          return {
            async query(...args: unknown[]) {
              const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : ""
              const result = await query(...args)
              if (sql === "BEGIN") {
                const pidResult = await query("SELECT pg_backend_pid()::int AS pid") as { rows: Array<{ pid: unknown }> }
                const pid = pidResult.rows[0]?.pid
                if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
                  throw new Error("Could not read the submission writer backend PID")
                }
                workerPidReady.resolve(pid)
              }
              return result
            },
            release,
          } as unknown as PoolClient
        },
      } as unknown as Pool

      workerOperation = updateJobForSubmission(
        workerPool, identity, { status: "applied", workflowState: "submitted", applied: true }, "finish_apply_job_state",
      )
      void workerOperation.then(() => { writerSettled = true }, () => { writerSettled = true })
      const workerPid = await withTimeout(workerPidReady.promise, "Worker submission transaction did not begin")
      await waitForBlocker(workerPid, webPid)
      expect(writerSettled).toBe(false)

      const blockedRead = await withTimeout(
        pool!.query<{ status: string }>(`SELECT "status" FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [jobId, userId]),
        "Blocked submission Job status readback timed out",
      )
      expect(blockedRead.rows).toEqual([{ status: "saved" }])

      releaseWeb.resolve(undefined)
      await withTimeout(webTransaction, "Web source fence transaction did not commit", CLEANUP_TIMEOUT_MS)
      await expect(withTimeout(workerOperation, "Submission Job writer did not finish", CLEANUP_TIMEOUT_MS))
        .resolves.toEqual({ kind: "current", value: true })
      const persisted = await withTimeout(
        pool!.query<{ status: string }>(`SELECT "status" FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [jobId, userId]),
        "Submission Job status readback timed out",
      )
      expect(persisted.rows).toEqual([{ status: "applied" }])
    } finally {
      releaseWeb.resolve(undefined)
      const settled = await settleOperations(workerOperation, webTransaction)
      if (!settled) {
        forceReleaseWorkerClient?.(new Error("Submission source-fence writer cleanup timed out"))
        await settleOperations(workerOperation, webTransaction)
      }
      await pool!.query(`DELETE FROM application_tasks WHERE "id" = $1 AND "userId" = $2`, [applicationTaskId, userId])
      await pool!.query(`DELETE FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [fillerTaskId, sessionId])
      await pool!.query(`DELETE FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [turnId, sessionId, userId])
      await pool!.query(`DELETE FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2`, [sessionId, userId])
      await pool!.query(`DELETE FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [jobId, userId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [userId])
    }
  }, TEST_TIMEOUT_MS)

  it("holds the Web user fence until the canonical source artifact writer commits", async () => {
    const userId = `source-fence-artifact-user-${randomUUID()}`
    const jobId = `source-fence-artifact-job-${randomUUID()}`
    const artifactId = `source-fence-artifact-${randomUUID()}`
    const gate = createArtifactWriterGate({ failCommit: false, holdRollback: false })
    const repository = createAgentArtifactRepository(withArtifactWriterGate(pool!, gate))
    const input = sourceArtifactBase(userId, jobId, artifactId)
    let writerOperation: Promise<unknown> | undefined
    let webWaiter: ReturnType<typeof startWebFenceWaiter> | undefined

    try {
      writerOperation = repository.insertBase(input)
      const writerPid = await withTimeout(gate.writerPid.promise, "Artifact writer did not begin its transaction")
      await withTimeout(gate.artifactInsertReached.promise, "Artifact writer did not issue its source row insert")
      await withTimeout(gate.commitReached.promise, "Artifact writer did not reach commit")

      webWaiter = startWebFenceWaiter(userId)
      const webPid = await withTimeout(webWaiter.backendPid, "Web transaction did not start")
      await waitForBlocker(webPid, writerPid)
      expect(webWaiter.isSettled()).toBe(false)

      gate.releaseCommit.resolve(undefined)
      const written = await withTimeout(writerOperation, "Artifact writer did not commit", CLEANUP_TIMEOUT_MS)
      expect(written).toMatchObject({ id: artifactId, userId, jobId, artifactType: "resume", lifecycle: "base" })
      await withTimeout(webWaiter.acquired, "Web fence did not acquire after artifact commit", CLEANUP_TIMEOUT_MS)
      await withTimeout(webWaiter.transaction, "Web transaction did not commit", CLEANUP_TIMEOUT_MS)

      const persisted = await withTimeout(
        pool!.query<{ id: string }>('SELECT "id" FROM "agent_artifact" WHERE "id" = $1 AND "userId" = $2', [artifactId, userId]),
        "Committed artifact readback timed out",
      )
      expect(persisted.rows).toEqual([{ id: artifactId }])
    } finally {
      await cleanupArtifactWriterCase(gate, writerOperation, webWaiter?.transaction, artifactId, userId)
    }
  }, TEST_TIMEOUT_MS)

  it("holds the Web user fence until the canonical source artifact writer rolls back", async () => {
    const userId = `source-fence-artifact-user-${randomUUID()}`
    const jobId = `source-fence-artifact-job-${randomUUID()}`
    const artifactId = `source-fence-artifact-${randomUUID()}`
    const gate = createArtifactWriterGate({ failCommit: true, holdRollback: true })
    const repository = createAgentArtifactRepository(withArtifactWriterGate(pool!, gate))
    const input = sourceArtifactBase(userId, jobId, artifactId)
    let writerOperation: Promise<unknown> | undefined
    let webWaiter: ReturnType<typeof startWebFenceWaiter> | undefined

    try {
      writerOperation = repository.insertBase(input)
      const writerPid = await withTimeout(gate.writerPid.promise, "Artifact writer did not begin its transaction")
      await withTimeout(gate.artifactInsertReached.promise, "Artifact writer did not issue its source row insert")
      await withTimeout(gate.commitReached.promise, "Artifact writer did not reach commit")

      webWaiter = startWebFenceWaiter(userId)
      const webPid = await withTimeout(webWaiter.backendPid, "Web transaction did not start")
      await waitForBlocker(webPid, writerPid)
      expect(webWaiter.isSettled()).toBe(false)

      gate.releaseCommit.resolve(undefined)
      await withTimeout(gate.rollbackReached.promise, "Artifact writer did not enter rollback")
      expect(await blockingPids(webPid)).toContain(writerPid)
      expect(webWaiter.isSettled()).toBe(false)

      gate.releaseRollback.resolve(undefined)
      const outcome = await withTimeout(writerOperation.then(
        () => ({ kind: "committed" as const }),
        (error: unknown) => ({ kind: "rolled_back" as const, error }),
      ), "Artifact writer did not finish rollback", CLEANUP_TIMEOUT_MS)
      expect(outcome.kind).toBe("rolled_back")
      if (outcome.kind !== "rolled_back" || !(outcome.error instanceof Error)) {
        throw new Error("Expected the artifact repository transaction to roll back")
      }
      expect(outcome.error.message).toBe("Injected disposable artifact commit failure")
      await withTimeout(webWaiter.acquired, "Web fence did not acquire after artifact rollback", CLEANUP_TIMEOUT_MS)
      await withTimeout(webWaiter.transaction, "Web transaction did not commit", CLEANUP_TIMEOUT_MS)

      const persisted = await withTimeout(
        pool!.query<{ id: string }>('SELECT "id" FROM "agent_artifact" WHERE "id" = $1 AND "userId" = $2', [artifactId, userId]),
        "Rolled-back artifact readback timed out",
      )
      expect(persisted.rows).toEqual([])
    } finally {
      await cleanupArtifactWriterCase(gate, writerOperation, webWaiter?.transaction, artifactId, userId)
    }
  }, TEST_TIMEOUT_MS)

  it("rejects autocommit calls in both adapters without logging or exposing identifiers", async () => {
    const privateWebUserId = `private-web-user-${randomUUID()}`
    const privateWorkerUserId = `private-worker-user-${randomUUID()}`
    const loggers = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ]
    let workerClient: PoolClient | undefined
    let webOperation: Promise<unknown> | undefined
    let workerOperation: Promise<unknown> | undefined

    try {
      workerClient = await pool!.connect()
      webOperation = acquireWebFence(prisma!, [privateWebUserId]).catch((error: unknown) => error)
      const webError = await withTimeout(webOperation, "Web autocommit probe timed out")
      workerOperation = acquireWorkerSourceMaterialFence(workerClient, [privateWorkerUserId])
        .catch((error: unknown) => error)
      const workerError = await withTimeout(workerOperation, "Worker autocommit probe timed out")
      if (!(webError instanceof Error)) throw new Error("Expected Web autocommit rejection")
      if (!(workerError instanceof Error)) throw new Error("Expected Worker autocommit rejection")

      expect(webError.message).toBe(TRANSACTION_ERROR)
      expect(workerError.message).toBe(TRANSACTION_ERROR)
      expect(String(webError)).not.toContain(privateWebUserId)
      expect(String(workerError)).not.toContain(privateWorkerUserId)
      for (const logger of loggers) expect(logger).not.toHaveBeenCalled()
    } finally {
      const settled = await settleOperations(webOperation, workerOperation)
      if (workerClient) {
        if (settled) workerClient.release()
        else workerClient.release(new Error("Source material fence test cleanup timed out"))
      }
    }
  }, TEST_TIMEOUT_MS)
})
