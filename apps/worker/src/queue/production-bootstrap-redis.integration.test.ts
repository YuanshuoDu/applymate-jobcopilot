import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Queue, type Job } from "bullmq"
import { Redis } from "ioredis"

const RUN_REDIS_INTEGRATION = process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1"

function dedicatedRedisUrl(): string | null {
  if (!RUN_REDIS_INTEGRATION) return null
  if (process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true") {
    throw new Error("Turn queue Redis integration requires an explicitly disposable Redis service")
  }
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) throw new Error("AGENT_TURN_REDIS_TEST_URL is required when the Redis integration gate is enabled")
  const url = new URL(value)
  if (
    url.protocol !== "redis:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379"
    || url.pathname !== "/15"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("Turn queue Redis integration accepts only a disposable loopback Redis DB 15 URL")
  }
  return value
}

const redisUrl = dedicatedRedisUrl()
const describeWithRedis = redisUrl ? describe : describe.skip

type TurnPayload = { turnId: string; sessionId: string; ownerId: string }
type FixtureOutbox = {
  id: string
  topic: string
  aggregateId: string
  idempotencyKey: string
  payload: TurnPayload
  publishedAt: Date | null
  attemptCount: number
}
type FixtureTurn = {
  id: string
  sessionId: string
  userId: string
  status: string
  leaseOwnerId: string | null
  leaseVersion: number
  leaseStartedAt: Date | null
  leaseExpiresAt: Date | null
}

/** Only the SQL state needed by the real dispatch scanner and lease fence. */
function createSqlFixture(ids: { turnId: string; sessionId: string; userId: string }) {
  const turn: FixtureTurn = {
    id: ids.turnId, sessionId: ids.sessionId, userId: ids.userId, status: "queued",
    leaseOwnerId: null, leaseVersion: 0, leaseStartedAt: null, leaseExpiresAt: null,
  }
  const state = {
    turn,
    outbox: null as FixtureOutbox | null,
    claimAttempts: [] as Array<{ turnId: string; sessionId: string; ownerId: string }>,
  }

  const client = {
    async query(sql: string, values: unknown[] = []) {
      const none = { rows: [] as Array<Record<string, unknown>>, rowCount: 0 }
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return none
      if (sql.includes("WITH candidates AS") || sql.includes("WITH stale AS")) return none
      if (sql.includes('SELECT turn."id", turn."sessionId"')) return none
      if (/SELECT\s+turn\."id"\s+FROM\s+"agent_turns"\s+AS\s+turn/.test(sql)) {
        return state.turn.id === values[0] && state.turn.sessionId === values[1]
          ? { rows: [{ id: state.turn.id }], rowCount: 1 }
          : none
      }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) {
        return values[0] === state.turn.sessionId
          ? { rows: [{ id: state.turn.sessionId }], rowCount: 1 }
          : none
      }
      if (sql.includes('SELECT dispatch."id", dispatch."aggregateId"')) {
        const row = state.outbox
        return row?.publishedAt === null
          ? { rows: [{ id: row.id, aggregateId: row.aggregateId, payload: row.payload, attemptCount: row.attemptCount }], rowCount: 1 }
          : none
      }
      if (sql.includes('SELECT dispatch."id" FROM "agent_outbox"')) {
        const row = state.outbox
        return row?.publishedAt === null && row.id === values[0] && row.aggregateId === values[1]
          ? { rows: [{ id: row.id }], rowCount: 1 }
          : none
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        if (state.outbox === null) {
          state.outbox = {
            id: String(values[0]), topic: String(values[1]), aggregateId: String(values[2]),
            idempotencyKey: String(values[3]), payload: JSON.parse(String(values[4])) as TurnPayload,
            publishedAt: null, attemptCount: 0,
          }
        }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("UPDATE \"agent_outbox\"")) {
        const row = state.outbox
        if (row && row.publishedAt === null) {
          const matches = values[0] === row.id || values[0] === row.idempotencyKey
          const sessionMatches = values.length < 2 || values[1] === row.aggregateId
          if (matches && sessionMatches) {
            row.publishedAt = new Date()
            row.attemptCount += 1
            return { rows: [], rowCount: 1 }
          }
        }
        return none
      }
      if (sql.includes('UPDATE "agent_turns"') && sql.includes(`SET "status" = 'in_progress'`)) {
        const [turnId, sessionId, ownerId, startedAt, leaseMs] = values
        state.claimAttempts.push({ turnId: String(turnId), sessionId: String(sessionId), ownerId: String(ownerId) })
        if (state.turn.status !== "queued" || state.turn.id !== turnId || state.turn.sessionId !== sessionId) return none
        state.turn.status = "in_progress"
        state.turn.leaseOwnerId = String(ownerId)
        state.turn.leaseVersion += 1
        state.turn.leaseStartedAt = startedAt as Date
        state.turn.leaseExpiresAt = new Date((startedAt as Date).getTime() + Number(leaseMs))
        return { rows: [{
          id: state.turn.id, sessionId: state.turn.sessionId, userId: state.turn.userId,
          leaseOwnerId: state.turn.leaseOwnerId, leaseVersion: state.turn.leaseVersion,
          leaseStartedAt: state.turn.leaseStartedAt, leaseExpiresAt: state.turn.leaseExpiresAt,
        }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns"') && sql.includes('SET "status" = $5')) {
        const [turnId, sessionId, ownerId, leaseVersion, status] = values
        if (state.turn.id !== turnId || state.turn.sessionId !== sessionId || state.turn.leaseOwnerId !== ownerId || state.turn.leaseVersion !== leaseVersion) return none
        state.turn.status = String(status)
        state.turn.leaseOwnerId = null
        state.turn.leaseStartedAt = null
        state.turn.leaseExpiresAt = null
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL in Redis queue integration fixture: ${sql.slice(0, 180)}`)
    },
    release() {},
  }

  return {
    state,
    pool: { async connect() { return client } },
    redeliverPendingOutbox() {
      if (!state.outbox) throw new Error("Turn dispatch outbox fixture was not persisted")
      state.outbox.publishedAt = null
    },
  }
}

async function waitForCompletedJob<T>(queue: Queue<T>, id: string, timeoutMs = 10_000): Promise<Job<T>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await queue.getJob(id)
    if (job) {
      const status = await job.getState()
      if (status === "completed") return job
      if (status === "failed") throw new Error(`Turn job ${id} failed: ${job.failedReason}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for Turn job ${id} to complete`)
}

describeWithRedis("production Turn dispatch and consumer (real Redis/BullMQ)", () => {
  let probeRedis: Redis | undefined
  let observerQueue: Queue<TurnPayload> | undefined
  const bootstraps: Array<{ close(): Promise<void> }> = []

  beforeAll(async () => {
    probeRedis = new Redis(redisUrl!, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectTimeout: 2_000,
      retryStrategy: attempt => attempt > 3 ? null : 100,
    })
    await probeRedis.connect()
    await probeRedis.ping()
    vi.doMock("../redis.js", () => ({
      redisConnection: probeRedis,
      redisCommandConnection: probeRedis,
      closeSharedRedisConnections: async () => undefined,
    }))
    const { TURN_QUEUE_NAME } = await import("../runtime/turns/turn-queue.js")
    observerQueue = new Queue<TurnPayload>(TURN_QUEUE_NAME, { connection: probeRedis, skipVersionCheck: true })
    await observerQueue.waitUntilReady()
    await observerQueue.obliterate({ force: true })
  }, 15_000)

  afterAll(async () => {
    for (const bootstrap of bootstraps.reverse()) await bootstrap.close().catch(() => undefined)
    await observerQueue?.obliterate({ force: true }).catch(() => undefined)
    await observerQueue?.close().catch(() => undefined)
    if (probeRedis && probeRedis.status !== "end") await probeRedis.quit().catch(() => probeRedis?.disconnect())
    vi.doUnmock("../redis.js")
  })

  it("dispatches the durable outbox through production recovery and fences replay after Worker reconstruction", async () => {
    const ids = { turnId: `redis-turn-${randomUUID()}`, sessionId: `redis-session-${randomUUID()}`, userId: `redis-user-${randomUUID()}` }
    const payload: TurnPayload = {
      turnId: ids.turnId,
      sessionId: ids.sessionId,
      ownerId: "redis-integration-worker",
    }
    const fixture = createSqlFixture(ids)
    const { persistTurnDispatch, turnJobId } = await import("../runtime/turns/recovery-scanner.js")
    const { startProductionAgentRuntime } = await import("./production-bootstrap.js")
    const executions: Array<{ turnId: string; sessionId: string; userId: string; ownerId: string; leaseVersion: number }> = []

    const makeRuntime = () => ({
      execute: async ({ lease }: { lease: { turnId: string; sessionId: string; userId: string; ownerId: string; leaseVersion: number } }) => {
        executions.push({ turnId: lease.turnId, sessionId: lease.sessionId, userId: lease.userId, ownerId: lease.ownerId, leaseVersion: lease.leaseVersion })
        return { status: "completed" as const }
      },
      manager: { interruptForTurn: async () => undefined, shutdown: async () => undefined },
      childExecutionEnabled: false,
      coordinationEnabled: false,
      close: async () => undefined,
    })

    await persistTurnDispatch(fixture.pool as never, payload)
    expect(Object.keys(fixture.state.outbox!.payload).sort()).toEqual(["ownerId", "sessionId", "turnId"])
    const firstBootstrap = await startProductionAgentRuntime({
      pool: fixture.pool as never,
      createRuntime: async () => makeRuntime() as never,
      bootstrapOptions: { ownerId: "redis-recovery-owner", turnRecoveryIntervalMs: 60_000 },
      startAgentRunWorker: () => undefined,
    })
    bootstraps.push(firstBootstrap)
    await firstBootstrap.turns.worker.waitUntilReady()

    const firstJobId = turnJobId(ids.turnId, 0)
    await waitForCompletedJob(observerQueue!, firstJobId)
    expect(executions).toEqual([{ ...ids, ownerId: payload.ownerId, leaseVersion: 1 }])
    expect(fixture.state.turn.status).toBe("completed")
    expect(fixture.state.outbox?.publishedAt).toBeInstanceOf(Date)

    // Model the uncertain handoff window: Redis delivery happened but the
    // durable outbox still appears pending when a fresh Worker bootstraps.
    await firstBootstrap.close()
    fixture.redeliverPendingOutbox()
    const secondBootstrap = await startProductionAgentRuntime({
      pool: fixture.pool as never,
      createRuntime: async () => makeRuntime() as never,
      bootstrapOptions: { ownerId: "redis-recovery-owner-2", turnRecoveryIntervalMs: 60_000 },
      startAgentRunWorker: () => undefined,
    })
    bootstraps.push(secondBootstrap)
    await secondBootstrap.turns.worker.waitUntilReady()

    const recoveredJobId = turnJobId(ids.turnId, 1)
    const recoveredJob = await waitForCompletedJob(observerQueue!, recoveredJobId)
    expect(recoveredJob.returnvalue).toMatchObject({ status: "skipped", reasonCode: "lease_not_available" })
    expect(fixture.state.claimAttempts).toEqual([
      { turnId: ids.turnId, sessionId: ids.sessionId, ownerId: payload.ownerId },
      { turnId: ids.turnId, sessionId: ids.sessionId, ownerId: payload.ownerId },
    ])
    expect(executions).toHaveLength(1)
    expect(executions[0]).toMatchObject({ ...ids, ownerId: payload.ownerId, leaseVersion: 1 })
    expect(fixture.state.turn).toMatchObject({ status: "completed", leaseOwnerId: null, leaseVersion: 1 })
  }, 25_000)
})
