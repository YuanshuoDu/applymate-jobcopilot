import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool } from "pg"

import { createCanonicalTurnRuntime } from "../canonical-turn-runtime.js"
import { INTERACTIVE_DISCOVERY_INTENT, type CanonicalTurnState } from "../canonical-turn-state.js"
import type { ProductionAgentFlags } from "../production-agent-flags.js"
import { createPgRootTaskStore, type RootTaskStore } from "./root-task-store.js"
import { recoverExpiredStoppedRoots } from "./root-task-stop-recovery.js"
import { startTaskGraphStopOutboxConsumer, TASK_GRAPH_STOP_OUTBOX_TOPIC } from "./task-graph-stop-outbox.js"
import type { TurnLease } from "../turns/lease.js"
import { runTurnJob } from "../turns/turn-queue.js"

vi.mock("../../redis.js", () => ({ redisConnection: {}, redisCommandConnection: {} }))

const DATABASE_NAME = "applymate_agent_brain_ci"
const STOPPED_ROOT_REASON = "Persisted Stop outlived the Worker lease before a terminal receipt was recorded."

type Fixture = Readonly<{ userId: string; sessionId: string; turnId: string; ownerId: string }>
type Deferred<T> = Readonly<{ promise: Promise<T>; resolve(value: T): void }>

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function dedicatedDisposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") {
      throw new Error("Required interactive discovery Stop integration has no disposable PostgreSQL URL")
    }
    return null
  }

  let url: URL
  try { url = new URL(value) } catch {
    throw new Error("Interactive discovery Stop integration requires the dedicated disposable CI PostgreSQL URL")
  }
  if (
    process.env.CI !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("Interactive discovery Stop integration accepts only the dedicated disposable CI PostgreSQL service URL")
  return value
}

const databaseUrl = dedicatedDisposableUrl()
const describeWithDisposablePostgres = databaseUrl ? describe : describe.skip

function fixture(): Fixture {
  const suffix = randomUUID()
  return {
    userId: `p3-discovery-stop-user-${suffix}`,
    sessionId: `p3-discovery-stop-session-${suffix}`,
    turnId: `p3-discovery-stop-turn-${suffix}`,
    ownerId: `p3-discovery-stop-owner-${suffix}`,
  }
}

async function seed(pool: Pool, value: Fixture): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Find and rank suitable jobs', 'running', 'test', CURRENT_TIMESTAMP)`, [value.sessionId, value.userId])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'queued', 'user', $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, CURRENT_TIMESTAMP)`, [
    value.turnId,
    value.sessionId,
    value.userId,
    JSON.stringify({ goal: "Find and rank suitable jobs", intent: INTERACTIVE_DISCOVERY_INTENT }),
    JSON.stringify({ provider: "fixture", model: "fixture-model" }),
    JSON.stringify({ capabilities: [] }),
    JSON.stringify({ limits: { maxSteps: 4, maxToolCalls: 2 } }),
  ])
}

async function persistStop(pool: Pool, value: Fixture, lease: TurnLease, rootTaskId: string): Promise<void> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [value.userId])
    await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [value.sessionId, value.userId])
    const current = await client.query<{ revision: number }>(`SELECT "revision" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
        AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "status" = 'in_progress' FOR UPDATE`, [
      value.turnId, value.sessionId, value.userId, rootTaskId, lease.ownerId, lease.leaseVersion,
    ])
    if (current.rowCount !== 1) throw new Error("Stop fixture could not lock the exact active Turn")
    const requestedAt = new Date()
    const stopped = await client.query(`UPDATE "agent_turns" SET "status" = 'interrupted',
        "revision" = "revision" + 1, "completedAt" = $7, "updatedAt" = $7
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
        AND "leaseOwnerId" = $5 AND "leaseVersion" = $6 AND "status" = 'in_progress'
        AND "revision" = $8`, [
      value.turnId, value.sessionId, value.userId, rootTaskId, lease.ownerId, lease.leaseVersion,
      requestedAt, Number(current.rows[0]?.revision),
    ])
    if (stopped.rowCount !== 1) throw new Error("Stop fixture lost the exact active Turn fence")
    const marked = await client.query(`UPDATE "sub_agent_tasks" SET
        "interruptRequestedAt" = COALESCE("interruptRequestedAt", $4), "updatedAt" = $4
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1
        AND "parentTaskId" IS NULL AND "status" = 'running'`, [rootTaskId, value.sessionId, value.turnId, requestedAt])
    if (marked.rowCount !== 1) throw new Error("Stop fixture could not persist the root interrupt marker")
    await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5::jsonb)`, [
      `task-graph-stop-${value.turnId}`,
      TASK_GRAPH_STOP_OUTBOX_TOPIC,
      value.sessionId,
      `agent-task-graph-stop:${value.sessionId}:${value.turnId}`,
      JSON.stringify({ sessionId: value.sessionId, turnId: value.turnId }),
    ])
    await client.query("COMMIT")
    committed = true
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function persistedInterrupt(pool: Pool, lease: TurnLease): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const result = await client.query<{ status: string }>(`SELECT "status" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [lease.turnId, lease.sessionId, lease.userId])
    await client.query("COMMIT")
    return result.rows[0]?.status === "interrupted"
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 8_000) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

async function waitForRootAndOutbox(pool: Pool, value: Fixture, rootTaskId: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const root = await pool.query<{ status: string; failureReason: string | null; result: unknown }>(`SELECT "status", "failureReason", "result"
      FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [rootTaskId, value.sessionId, value.turnId])
    const outbox = await pool.query<{ publishedAt: Date | null }>(`SELECT "publishedAt" FROM "agent_outbox"
      WHERE "topic" = $1 AND "aggregateId" = $2 AND "idempotencyKey" = $3`, [
      TASK_GRAPH_STOP_OUTBOX_TOPIC, value.sessionId, `agent-task-graph-stop:${value.sessionId}:${value.turnId}`,
    ])
    if (root.rows[0]?.status === "interrupted" && outbox.rows[0]?.publishedAt) {
      expect(root.rows[0]?.failureReason).toBe(STOPPED_ROOT_REASON)
      expect(root.rows[0]?.result).toMatchObject({ status: "interrupted" })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error("Stop outbox consumer did not converge the expired root and publish its intent")
}

describeWithDisposablePostgres("interactive discovery Stop recovery without subagent execution", () => {
  let pool: Pool | undefined

  beforeAll(async () => {
    if (!databaseUrl) return
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    await pool.query("SELECT 1")
  })

  afterAll(async () => { await pool?.end() })

  it("fences fallback output, then converges the stopped root from the always-on Worker consumer", async () => {
    const db = pool
    if (!db) throw new Error("Disposable PostgreSQL fixture was not initialized")
    const value = fixture()
    await seed(db, value)

    const persistedRoots = createPgRootTaskStore(db)
    const fallbackEnsureEntered = deferred<void>()
    const releaseFallback = deferred<void>()
    const interruptObserved = deferred<void>()
    let ensureCount = 0
    let rootTaskId = ""
    let oldLease: TurnLease | undefined
    const roots: RootTaskStore = {
      ...persistedRoots,
      async ensure(input) {
        ensureCount += 1
        oldLease = input.lease
        const root = await persistedRoots.ensure(input)
        if (ensureCount === 1) {
          rootTaskId = root.id
          fallbackEnsureEntered.resolve(undefined)
          await releaseFallback.promise
        }
        return root
      },
    }
    const productionFlags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: false,
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
    }
    const state: CanonicalTurnState = {
      scope: { userId: value.userId },
      goal: "Find and rank suitable jobs",
      modelProfileSnapshot: { provider: "fixture", model: "fixture-model" },
      toolPolicySnapshot: { capabilities: [] },
      budgetSnapshot: { limits: { maxSteps: 4, maxToolCalls: 2 } },
      intent: INTERACTIVE_DISCOVERY_INTENT,
      snapshot: {
        system: [], profile: [], goal: { id: "discovery-goal", content: "Find and rank suitable jobs" },
        steerHistory: [], businessRefs: [], toolObservations: [],
      },
    }
    const modelRuntimeFactory = vi.fn(() => { throw new Error("Interactive discovery fallback must not invoke a model") })
    let runtime: Awaited<ReturnType<typeof createCanonicalTurnRuntime>> | undefined
    let consumer: ReturnType<typeof startTaskGraphStopOutboxConsumer> | undefined
    let run: ReturnType<typeof runTurnJob> | undefined
    try {
      runtime = await createCanonicalTurnRuntime(db, {
        workerId: "worker-1",
        productionFlags,
        rootTaskStore: roots,
        stateLoader: async () => state,
        selectedJobPreparationLoader: async () => undefined,
        toolRuntimeFactory: () => ({ registry: { list: () => [], resolve: () => ({ idempotency: "read_only" }), validateArguments: () => true }, router: {} } as never),
        modelRuntimeFactory,
      })
      run = runTurnJob({ data: { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId }, attemptsMade: 0 }, {
        pool: db,
        execute: input => {
          oldLease = input.lease
          if (input.signal.aborted) interruptObserved.resolve(undefined)
          else input.signal.addEventListener("abort", () => interruptObserved.resolve(undefined), { once: true })
          if (!runtime) throw new Error("Canonical Worker runtime was not initialized")
          return runtime.execute(input)
        },
        heartbeatMs: 60_000,
        interruptPollMs: 5,
        isInterrupted: lease => persistedInterrupt(db, lease),
      })

      await within(fallbackEnsureEntered.promise, "interactive discovery fallback root ensure")
      expect(ensureCount).toBe(1)
      expect(rootTaskId).toBe(`root-${value.turnId}`)
      if (!oldLease) throw new Error("Worker-1 did not capture its canonical Turn lease")
      await persistStop(db, value, oldLease, rootTaskId)
      await within(interruptObserved.promise, "Worker-1 persisted Stop probe")
      releaseFallback.resolve(undefined)
      await expect(within(run, "Worker-1 Stop result")).resolves.toMatchObject({ status: "interrupted" })

      const expired = await db.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "status" = 'running'
          AND "interruptRequestedAt" IS NOT NULL`, [rootTaskId, value.sessionId, value.turnId])
      expect(expired.rowCount).toBe(1)

      consumer = startTaskGraphStopOutboxConsumer(db, { pollMs: 250 })
      await waitForRootAndOutbox(db, value, rootTaskId)
      if (!oldLease) throw new Error("The stopped Worker lease was not retained for stale-write verification")
      await expect(persistedRoots.finish({
        lease: oldLease,
        rootTaskId,
        result: { status: "completed", stepCount: 1, toolCallCount: 0 },
      })).rejects.toThrow("root_turn_fenced")
      await expect(recoverExpiredStoppedRoots(db)).resolves.toBe(0)

      const turn = await db.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [value.turnId, value.sessionId, value.userId])
      const lifecycleEvents = await db.query<{ id: string; itemId: string | null; taskId: string | null; sequence: string; type: string; actor: string; correlationId: string; idempotencyKey: string; payload: Record<string, unknown> }>(`SELECT "id", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload"
        FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task.interrupted'
          AND "idempotencyKey" = $4`, [value.sessionId, value.turnId, rootTaskId,
        `agent-root-stop:${rootTaskId}:attempt:1:task.interrupted`])
      const lifecycleOutbox = await db.query<{ id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: Record<string, unknown> }>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload"
        FROM "agent_outbox" WHERE "topic" = 'agent.session.event' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [
        value.sessionId, `agent-event-agent-root-stop-${rootTaskId}-attempt-1`,
      ])
      const finalItems = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'agent_message' AND "phase" = 'final_answer'`, [value.sessionId, value.turnId, rootTaskId])
      const completedEvents = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'turn.completed'`, [value.sessionId, value.turnId])
      expect(turn.rows[0]?.status).toBe("interrupted")
      expect(lifecycleEvents.rowCount).toBe(1)
      expect(lifecycleEvents.rows[0]).toMatchObject({
        id: `agent-root-stop-${rootTaskId}-attempt-1`, itemId: null, taskId: rootTaskId,
        type: "task.interrupted", actor: "system", correlationId: value.turnId,
        idempotencyKey: `agent-root-stop:${rootTaskId}:attempt:1:task.interrupted`,
        payload: { taskId: rootTaskId, status: "interrupted", attemptCount: 1 },
      })
      expect(lifecycleOutbox.rowCount).toBe(1)
      expect(lifecycleOutbox.rows[0]).toMatchObject({
        topic: "agent.session.event", aggregateId: value.sessionId,
        idempotencyKey: `agent-event-agent-root-stop-${rootTaskId}-attempt-1`,
        payload: {
          eventId: `agent-root-stop-${rootTaskId}-attempt-1`, sessionId: value.sessionId,
          turnId: value.turnId, itemId: null, taskId: rootTaskId, type: "task.interrupted",
          actor: "system", correlationId: value.turnId,
          idempotencyKey: `agent-root-stop:${rootTaskId}:attempt:1:task.interrupted`,
        },
      })
      expect(lifecycleOutbox.rows[0]?.payload).not.toHaveProperty("payload.kind")
      expect(finalItems.rows[0]?.count).toBe(0)
      expect(completedEvents.rows[0]?.count).toBe(0)
      expect(modelRuntimeFactory).not.toHaveBeenCalled()
    } finally {
      releaseFallback.resolve(undefined)
      await consumer?.close()
      await run?.catch(() => undefined)
      await runtime?.close()
      await db.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 30_000)
})
