import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Queue, type Job } from "bullmq"
import { Redis } from "ioredis"
import { SESSION_CONTROL_RECOVERY_MAX_BATCH } from "../runtime/session-control/pause-recovery.js"

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
  source: string
  executionMode: string | null
  status: string
  leaseOwnerId: string | null
  leaseVersion: number
  leaseStartedAt: Date | null
  leaseExpiresAt: Date | null
}

/** Only the SQL state needed by the real dispatch scanner and lease fence. */
function createSqlFixture(ids: { turnId: string; sessionId: string; userId: string }) {
  const turn: FixtureTurn = {
    id: ids.turnId, sessionId: ids.sessionId, userId: ids.userId,
    source: "user", executionMode: null, status: "queued",
    leaseOwnerId: null, leaseVersion: 0, leaseStartedAt: null, leaseExpiresAt: null,
  }
  const state = {
    turn,
    outbox: null as FixtureOutbox | null,
    claimAttempts: [] as Array<{ turnId: string; sessionId: string; ownerId: string }>,
    modeLookupShapes: [] as Array<"id-source-mode" | "source-mode">,
  }

  const client = {
    async query(sql: string, values: unknown[] = []) {
      const none = { rows: [] as Array<Record<string, unknown>>, rowCount: 0 }
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return none
      if (sql.includes("SELECT set_config('app.user_id'")) return { rows: [], rowCount: 1 }
      const sessionControlSql = sql.toLowerCase()
      const isSessionControlRecoveryScan =
        sessionControlSql.includes("agent_sessions")
        && sessionControlSql.includes("agent_turns")
        && sessionControlSql.includes("agent_events")
        && sessionControlSql.includes("pausing")
        && sessionControlSql.includes("resuming")
      if (isSessionControlRecoveryScan) {
        if (
          !sql.includes('COALESCE(session."sessionControlRecoveryAttemptedAt", session."createdAt")')
          || !sql.includes('session."sessionControlRecoveryClaimToken" IS NULL')
          || !sql.includes('session."sessionControlRecoveryClaimExpiresAt" <= clock_timestamp()')
          || !sql.includes("FOR UPDATE OF session SKIP LOCKED")
          || !sql.includes("LIMIT $1")
          || values.length !== 1
          || values[0] !== SESSION_CONTROL_RECOVERY_MAX_BATCH
        ) {
          throw new Error("Session control recovery fixture expected the ordered, locked 50-row lease claim query")
        }
        return none
      }
      if (sql.includes("WITH candidates AS") || sql.includes("WITH stale AS")) return none
      const normalizedSql = sql.replace(/\s+/g, " ").trim()
      const modeLookupShape = normalizedSql.startsWith('SELECT turn."id", turn."source", turn."executionMode" FROM "agent_turns" AS turn')
        ? "id-source-mode"
        : normalizedSql.startsWith('SELECT turn."source", turn."executionMode" FROM "agent_turns" AS turn')
          ? "source-mode"
          : null
      if (modeLookupShape) {
        state.modeLookupShapes.push(modeLookupShape)
        return state.turn.id === values[0] && state.turn.sessionId === values[1]
          ? {
            rows: [modeLookupShape === "id-source-mode"
              ? { id: state.turn.id, source: state.turn.source, executionMode: state.turn.executionMode }
              : { source: state.turn.source, executionMode: state.turn.executionMode }],
            rowCount: 1,
          }
          : none
      }
      if (sql.includes('SELECT turn."id", turn."sessionId"')) return none
      if (/SELECT\s+turn\."id"\s+FROM\s+"agent_turns"\s+AS\s+turn/.test(sql)) {
        return state.turn.id === values[0] && state.turn.sessionId === values[1]
          ? { rows: [{ id: state.turn.id }], rowCount: 1 }
          : none
      }
      if (/SELECT\s+session\."userId"\s+FROM\s+"agent_sessions"\s+AS\s+session/.test(sql)) {
        return values[0] === state.turn.sessionId && values[1] === state.turn.id
          ? { rows: [{ userId: state.turn.userId }], rowCount: 1 }
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
      if (sql.includes('UPDATE "agent_turns"') && /SET\s+"status"\s*=\s*\$5/.test(sql)) {
        const fencedUpdate = /WHERE\s+"id"\s*=\s*\$1\s+AND\s+"sessionId"\s*=\s*\$2\s+AND\s+"leaseOwnerId"\s*=\s*\$3\s+AND\s+"leaseVersion"\s*=\s*\$4\s+AND\s+"userId"\s*=\s*\$7/i.test(sql)
          && /AND\s+"leaseExpiresAt"\s*>\s*\$6/i.test(sql)
          && /AND\s*\(\s*"status"\s*=\s*'in_progress'\s+OR\s*\(\s*"status"\s*=\s*'waiting_for_user'\s+AND\s+\$5\s*=\s*'waiting_for_user'\s*\)\s+OR\s*\(\s*"status"\s*=\s*'waiting_for_approval'\s+AND\s+\$5\s*=\s*'waiting_for_approval'\s*\)\s*\)/i.test(sql)
        if (!fencedUpdate) throw new Error("Turn lease release fixture expected owner/version/user/expiry/status predicates")
        const [turnId, sessionId, ownerId, leaseVersion, status, now, userId] = values
        const hasOpenLease = state.turn.leaseExpiresAt instanceof Date && now instanceof Date
          && state.turn.leaseExpiresAt.getTime() > now.getTime()
        const statusMatches = state.turn.status === "in_progress"
          || (state.turn.status === "waiting_for_user" && status === "waiting_for_user")
          || (state.turn.status === "waiting_for_approval" && status === "waiting_for_approval")
        if (state.turn.id !== turnId || state.turn.sessionId !== sessionId || state.turn.userId !== userId
          || state.turn.leaseOwnerId !== ownerId || state.turn.leaseVersion !== leaseVersion || !hasOpenLease || !statusMatches) return none
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

describe("production bootstrap SQL fixture", () => {
  it("answers both production execution-mode lookup projections", async () => {
    const ids = { turnId: "fixture-turn", sessionId: "fixture-session", userId: "fixture-user" }
    const fixture = createSqlFixture(ids)
    const client = await fixture.pool.connect()
    const deliveryLineage = await client.query(
      `SELECT turn."id", turn."source", turn."executionMode"
       FROM "agent_turns" AS turn
       JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
       WHERE turn."id" = $1 AND turn."sessionId" = $2
       FOR UPDATE OF turn, session`,
      [ids.turnId, ids.sessionId],
    )
    const canonicalIntake = await client.query(
      `SELECT turn."source", turn."executionMode"
       FROM "agent_turns" AS turn
       JOIN "agent_sessions" AS session
         ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
       WHERE turn."id" = $1 AND turn."sessionId" = $2`,
      [ids.turnId, ids.sessionId],
    )

    expect(deliveryLineage.rows[0]).toEqual({ id: ids.turnId, source: "user", executionMode: null })
    expect(canonicalIntake.rows[0]).toEqual({ source: "user", executionMode: null })
    expect(fixture.state.modeLookupShapes).toEqual(["id-source-mode", "source-mode"])
  })
})

async function waitForCompletedJob<T>(queue: Queue<T>, id: string, timeoutMs = 10_000): Promise<Job<T>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await queue.getJob(id)
    if (job) {
      const status = await job.getState()
      if (status === "completed") {
        // getState reads Redis, but the Job's returnvalue is the snapshot from getJob above.
        const completedJob = await queue.getJob(id)
        if (!completedJob) throw new Error(`Completed Turn job ${id} disappeared before result read`)
        return completedJob
      }
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
    const firstJob = await waitForCompletedJob(observerQueue!, firstJobId)
    expect(firstJob.returnvalue).toMatchObject({ status: "completed" })
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
    expect(fixture.state.modeLookupShapes).toEqual(expect.arrayContaining(["id-source-mode", "source-mode"]))
  }, 25_000)
})
