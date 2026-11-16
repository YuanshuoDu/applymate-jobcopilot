import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool, type PoolClient } from "pg"

// Worker Vitest aliases this test-only Web import to apps/web/src.
// @ts-expect-error The Worker TypeScript project does not compile Web path aliases.
import { acquireSourceMaterialFence as acquireWebSourceMaterialFence } from "@/lib/agent/source-material-fence"
import { acquireSourceMaterialFence as acquireWorkerSourceMaterialFence } from "./source-material-fence.js"

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
