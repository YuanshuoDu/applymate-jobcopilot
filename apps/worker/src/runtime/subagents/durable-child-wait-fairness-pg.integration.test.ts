import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { executionOwnerFence } from "../execution-owner.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy, type SubagentLease, type SubagentTaskRecord } from "./types.js"
import { registerDurableSubagentWait } from "./durable-subagent-wait-store.js"
import { reconcileDurableSubagentWaits } from "./durable-subagent-wait-resolver.js"

const DATABASE_NAME = "applymate_agent_brain_ci"

type Fixture = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  parentTaskId: string
  targetTaskId: string
  stepId: string
  waitId: string
}>

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Required child-wait PostgreSQL URL is missing")
    return null
  }
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== "" || url.hash !== "") throw new Error("Fair child-wait test accepts only the disposable PostgreSQL service")
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describePg = databaseUrl ? describe : describe.skip

function leaseFor(record: SubagentTaskRecord, ownerId: string): SubagentLease {
  if (!record.leaseExpiresAt) throw new Error("Fixture lease expiry is missing")
  return { ...record, ownerId, leaseExpiresAt: record.leaseExpiresAt, signal: new AbortController().signal }
}

async function startWaitingStep(pool: Pool, lease: SubagentLease, suffix: string): Promise<string> {
  const store = createPgTurnEngineStore(pool)
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `fair-wait-step:${suffix}`
  const step = await store.startStep({ owner, stepId, ordinal: 0, attempt: lease.attemptCount,
    inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now: new Date() })
  await store.updateStep({ owner, stepId: step.id, status: "waiting_for_tool", finishReason: "tool_call",
    errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: new Date() })
  return step.id
}

async function completeTarget(pool: Pool, store: PgSubagentTaskStore, fixture: Pick<Fixture, "sessionId" | "targetTaskId">,
  policy: ReturnType<typeof defaultSubagentPolicy>, suffix: string): Promise<void> {
  const ownerId = `fair-target-${suffix}`
  const record = await store.claim({ taskId: fixture.targetTaskId, sessionId: fixture.sessionId, ownerId, policy, now: new Date() })
  if (!record) throw new Error("Fixture target could not be claimed")
  const lease = leaseFor(record, ownerId)
  const storeSteps = createPgTurnEngineStore(pool)
  const owner = executionOwnerFence({ kind: "task", lease })
  const step = await storeSteps.startStep({ owner, stepId: `fair-target-step:${suffix}`, ordinal: 0,
    attempt: lease.attemptCount, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now: new Date() })
  await storeSteps.updateStep({ owner, stepId: step.id, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: new Date() })
  const result = await store.finish({ taskId: fixture.targetTaskId, sessionId: fixture.sessionId, ownerId,
    attemptCount: lease.attemptCount, status: "completed", result: { finalText: "target finished" }, now: new Date() })
  if (result !== "completed") throw new Error("Fixture target did not complete")
}

async function seedWait(pool: Pool, userId: string, suffix: string, ready: boolean): Promise<Fixture> {
  const sessionId = `fair-session-${suffix}`
  const turnId = `fair-turn-${suffix}`
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'fair child wait fixture', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'system', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [turnId, sessionId, userId])

  const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
  const store = new PgSubagentTaskStore(pool, 60_000)
  const root = await store.create({ userId, sessionId, turnId, role: "orchestrator", taskType: "root",
    goal: "fairness fixture root", allowedActions: ["wait_subagents"], policy })
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1 AND "sessionId" = $3`,
    [turnId, root.id, sessionId])
  await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1 AND "sessionId" = $2`, [root.id, sessionId])
  const parent = await store.create({ userId, sessionId, turnId, parentTaskId: root.id, role: "analyst", taskType: "research",
    goal: "wait for direct child", allowedActions: ["wait_subagents"], policy })
  const target = await store.create({ userId, sessionId, turnId, parentTaskId: parent.id, role: "scout", taskType: "research",
    goal: "direct wait target", policy })
  const parentOwnerId = `fair-parent-${suffix}`
  const parentRecord = await store.claim({ taskId: parent.id, sessionId, ownerId: parentOwnerId, policy, now: new Date() })
  if (!parentRecord) throw new Error("Fixture wait parent could not be claimed")
  const parentLease = leaseFor(parentRecord, parentOwnerId)
  const stepId = await startWaitingStep(pool, parentLease, suffix)
  const wait = await registerDurableSubagentWait(pool, {
    lease: parentLease, stepId, idempotencyKey: `fair-wait:${suffix}`, targetTaskIds: [target.id],
    mode: "any", timeoutMs: 60 * 60 * 1000, now: new Date(),
  })
  if (wait.status !== "waiting") throw new Error("Fixture wait was not registered as waiting")
  const handoff = await store.finish({ taskId: parent.id, sessionId, ownerId: parentOwnerId,
    attemptCount: parentLease.attemptCount, status: "waiting", now: new Date() })
  if (handoff !== "waiting") throw new Error("Fixture parent did not suspend on its wait")
  await pool.query(`UPDATE "agent_wait_conditions" SET "suspendedAt" = timezone('UTC', clock_timestamp()) - INTERVAL '1 day',
      "deadlineAt" = timezone('UTC', clock_timestamp()) + INTERVAL '1 hour', "nextReconcileAt" = NULL
    WHERE "id" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3`, [wait.waitId, sessionId, parent.id])
  const fixture = { userId, sessionId, turnId, rootTaskId: root.id, parentTaskId: parent.id, targetTaskId: target.id, stepId, waitId: wait.waitId }
  if (ready) await completeTarget(pool, store, fixture, policy, suffix)
  return fixture
}

async function makeTargetOutOfScope(pool: Pool, fixture: Fixture): Promise<void> {
  await pool.query(`UPDATE "agent_wait_conditions" SET "targetTaskIds" = jsonb_build_array($1)
    WHERE "id" = $2 AND "sessionId" = $3 AND "parentTaskId" = $4`,
  [fixture.rootTaskId, fixture.waitId, fixture.sessionId, fixture.parentTaskId])
}

async function setSessionDue(pool: Pool, fixture: Pick<Fixture, "sessionId">, ageSeconds: number): Promise<void> {
  await pool.query(`UPDATE "agent_wait_conditions" SET "suspendedAt" = timezone('UTC', clock_timestamp()) - ($2::int * INTERVAL '1 second'),
      "nextReconcileAt" = NULL WHERE "sessionId" = $1 AND "status" = 'waiting' AND "consumedAt" IS NULL`,
  [fixture.sessionId, ageSeconds])
}

async function waitForDeadline(pool: Pool, waitId: string): Promise<void> {
  const timeout = Date.now() + 15_000
  while (Date.now() < timeout) {
    const result = await pool.query<{ elapsed: boolean }>(`SELECT wait."deadlineAt" <= timezone('UTC', clock_timestamp()) AS "elapsed"
      FROM "agent_wait_conditions" AS wait WHERE wait."id" = $1`, [waitId])
    if (result.rows[0]?.elapsed === true) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error("Child wait deadline did not elapse while the target row was locked")
}

async function waitForSignal(signal: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([signal, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 15_000)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function observeTargetRead(pool: Pool, batchSize: number) {
  let signalTargetRead!: () => void
  const targetReadReached = new Promise<void>(resolve => { signalTargetRead = resolve })
  let targetReadReturned = false
  const observingPool: Pick<Pool, "connect"> = {
    connect: async () => {
      const client = await pool.connect()
      let observed = false
      return {
        query: async (sql: string, values?: unknown[]) => {
          const isTargetRead = !observed && sql.includes('ANY($1::text[])')
          if (isTargetRead) { observed = true; signalTargetRead() }
          const result = await client.query(sql, values as never)
          if (isTargetRead) targetReadReturned = true
          return result
        },
        release: () => client.release(),
      } as unknown as PoolClient
    },
  }
  return {
    completion: reconcileDurableSubagentWaits(observingPool, { batchSize }),
    targetReadReached,
    targetReadReturned: () => targetReadReturned,
  }
}

describePg("fair durable child-wait reconciliation on disposable PostgreSQL", () => {
  let pool: Pool
  let userId: string

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 8 })
  })

  beforeEach(async () => {
    userId = `fair-wait-user-${randomUUID()}`
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
      [userId, `${userId}@example.invalid`])
  })

  afterEach(async () => {
    if (userId) await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [userId]).catch(() => undefined)
  })

  afterAll(async () => {
    await pool?.end()
  })

  it("deploys a nullable timestamp schedule column and the migration-only due index", async () => {
    const column = await pool.query<{ dataType: string; nullable: string; precision: number }>(
      `SELECT "data_type" AS "dataType", "is_nullable" AS "nullable", "datetime_precision" AS "precision"
        FROM information_schema.columns WHERE "table_schema" = current_schema()
          AND "table_name" = 'agent_wait_conditions' AND "column_name" = 'nextReconcileAt'`)
    expect(column.rows).toEqual([{ dataType: "timestamp without time zone", nullable: "YES", precision: 3 }])
    const index = await pool.query<{ definition: string }>(
      `SELECT indexdef AS "definition" FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'agent_wait_conditions' AND indexname = 'agent_wait_conditions_child_wait_due_idx'`)
    const definition = index.rows[0]?.definition ?? ""
    expect(definition).toContain('COALESCE("nextReconcileAt", "suspendedAt")')
    expect(definition).toMatch(/status"?\s*=\s*'waiting'/)
    expect(definition).toMatch(/consumedAt"?\s+IS\s+NULL/)
  })

  it("advances old waits so a later ready session is reached after the finite backlog", async () => {
    const suffix = randomUUID()
    const old: Fixture[] = []
    for (let index = 0; index < 25; index++) old.push(await seedWait(pool, userId, `${suffix}-${index}`, false))
    const ready = await seedWait(pool, userId, `${suffix}-ready`, true)
    for (const fixture of old) await setSessionDue(pool, fixture, 172_800)

    const first = await reconcileDurableSubagentWaits(pool, { batchSize: 25 })
    expect(first).toMatchObject({ scanned: 25, resolved: 0, woken: 0 })
    const scheduled = await pool.query<{ count: number; advancedCount: number; readyStatus: string }>(
      `SELECT COUNT(*)::int AS "count", COUNT(*) FILTER (WHERE wait."nextReconcileAt" > wait."suspendedAt")::int AS "advancedCount",
        (SELECT "status" FROM "agent_wait_conditions" WHERE "id" = $1) AS "readyStatus"
        FROM "agent_wait_conditions" AS wait WHERE wait."sessionId" = ANY($2::text[]) AND wait."status" = 'waiting'`,
      [ready.waitId, old.map(item => item.sessionId)])
    expect(scheduled.rows[0]).toEqual({ count: 25, advancedCount: 25, readyStatus: "waiting" })
    // Keep this assertion independent of a slow CI machine consuming the five-second backoff.
    await pool.query(`UPDATE "agent_wait_conditions" SET "nextReconcileAt" = timezone('UTC', clock_timestamp()) + INTERVAL '1 minute'
      WHERE "sessionId" = ANY($1::text[]) AND "status" = 'waiting' AND "consumedAt" IS NULL`, [old.map(item => item.sessionId)])

    const second = await reconcileDurableSubagentWaits(pool, { batchSize: 25 })
    expect(second).toMatchObject({ scanned: 1, resolved: 1, woken: 1 })
    const final = await pool.query<{ waitStatus: string; taskStatus: string; dispatchCount: number }>(
      `SELECT wait."status" AS "waitStatus", parent."status" AS "taskStatus",
        (SELECT COUNT(*)::int FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = $1) AS "dispatchCount"
        FROM "agent_wait_conditions" AS wait JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId"
        WHERE wait."id" = $2 AND parent."sessionId" = $3`,
      [`subagent-dispatch:${ready.parentTaskId}`, ready.waitId, ready.sessionId])
    expect(final.rows[0]).toEqual({ waitStatus: "ready", taskStatus: "queued", dispatchCount: 1 })
  }, 90_000)

  it("backs off same-owner poison rows and progresses through oversized same-session corruption", async () => {
    const suffix = randomUUID()
    const poison: Fixture[] = []
    for (let index = 0; index < 25; index++) {
      const fixture = await seedWait(pool, userId, `${suffix}-poison-${index}`, false)
      await makeTargetOutOfScope(pool, fixture)
      poison.push(fixture)
    }
    const ready = await seedWait(pool, userId, `${suffix}-ready`, true)
    for (const fixture of poison) await setSessionDue(pool, fixture, 172_800)
    const poisonScan = await reconcileDurableSubagentWaits(pool, { batchSize: 25 })
    expect(poisonScan).toMatchObject({ scanned: 25, resolved: 0, woken: 0 })
    const poisonState = await pool.query<{ count: number; advancedCount: number }>(
      `SELECT COUNT(*)::int AS "count", COUNT(*) FILTER (WHERE "nextReconcileAt" > "suspendedAt")::int AS "advancedCount"
        FROM "agent_wait_conditions" WHERE "sessionId" = ANY($1::text[]) AND "status" = 'waiting' AND "consumedAt" IS NULL`,
      [poison.map(item => item.sessionId)])
    expect(poisonState.rows[0]).toEqual({ count: 25, advancedCount: 25 })
    await pool.query(`UPDATE "agent_wait_conditions" SET "nextReconcileAt" = timezone('UTC', clock_timestamp()) + INTERVAL '1 minute'
      WHERE "sessionId" = ANY($1::text[]) AND "status" = 'waiting' AND "consumedAt" IS NULL`, [poison.map(item => item.sessionId)])
    expect((await reconcileDurableSubagentWaits(pool, { batchSize: 25 })).woken).toBe(1)
    expect((await pool.query(`SELECT "status" FROM "agent_wait_conditions" WHERE "id" = $1`, [ready.waitId])).rows[0]?.status).toBe("ready")

    const crowded = await seedWait(pool, userId, `${suffix}-crowded`, true)
    for (let index = 0; index < 6; index++) {
      await pool.query(`INSERT INTO "agent_wait_conditions" (
        "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds", "mode", "status",
        "deadlineAt", "matchedTaskIds", "result", "createdAt", "updatedAt", "suspendedAt", "nextReconcileAt")
        SELECT $2, source."userId", source."sessionId", source."turnId", source."parentTaskId", source."stepId", $3,
          jsonb_build_array($4), source."mode", 'waiting', source."deadlineAt", '[]'::jsonb, source."result",
          timezone('UTC', clock_timestamp()) - ($5::int * INTERVAL '1 day'),
          timezone('UTC', clock_timestamp()) - ($5::int * INTERVAL '1 day'),
          timezone('UTC', clock_timestamp()) - ($5::int * INTERVAL '1 day'), NULL
        FROM "agent_wait_conditions" AS source WHERE source."id" = $1`,
      [crowded.waitId, `${crowded.waitId}-poison-${index}`, `fair-poison:${crowded.waitId}:${index}`, crowded.rootTaskId, 2 + index])
    }
    const statuses: Array<{ scanned: number; woken: number }> = []
    for (let index = 0; index < 7; index++) statuses.push(await reconcileDurableSubagentWaits(pool, { batchSize: 25 }))
    expect(statuses.map(result => result.scanned)).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(statuses.map(result => result.woken)).toEqual([0, 0, 0, 0, 0, 0, 1])
    const crowdedState = await pool.query<{ status: string; poisonCount: number; scheduledCount: number }>(
      `SELECT base."status", COUNT(poison."id")::int AS "poisonCount",
        COUNT(poison."id") FILTER (WHERE poison."nextReconcileAt" > poison."suspendedAt")::int AS "scheduledCount"
        FROM "agent_wait_conditions" AS base LEFT JOIN "agent_wait_conditions" AS poison
          ON poison."sessionId" = base."sessionId" AND poison."id" <> base."id" AND poison."idempotencyKey" LIKE $2
        WHERE base."id" = $1 GROUP BY base."status"`, [crowded.waitId, `fair-poison:${crowded.waitId}:%`])
    expect(crowdedState.rows[0]).toEqual({ status: "ready", poisonCount: 6, scheduledCount: 6 })
  }, 90_000)

  it("skips a locked earlier session and wakes a later ready session once under concurrent pollers", async () => {
    const suffix = randomUUID()
    const blocked = await seedWait(pool, userId, `${suffix}-locked`, false)
    const ready = await seedWait(pool, userId, `${suffix}-ready`, true)
    await setSessionDue(pool, blocked, 120)
    await setSessionDue(pool, ready, 60)
    const lockClient = await pool.connect()
    try {
      await lockClient.query("BEGIN")
      await lockClient.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [blocked.sessionId])
      const unlocked = await reconcileDurableSubagentWaits(pool, { batchSize: 1 })
      expect(unlocked).toMatchObject({ scanned: 1, resolved: 1, woken: 1 })
      const lockedState = await pool.query<{ status: string; nextReconcileAt: Date | null }>(
        `SELECT wait."status", wait."nextReconcileAt" FROM "agent_wait_conditions" AS wait WHERE wait."id" = $1`, [blocked.waitId])
      expect(lockedState.rows[0]).toEqual({ status: "waiting", nextReconcileAt: null })
    } finally {
      await lockClient.query("ROLLBACK").catch(() => undefined)
      lockClient.release()
    }

    await pool.query(`UPDATE "agent_wait_conditions" SET "nextReconcileAt" = timezone('UTC', clock_timestamp()) + INTERVAL '1 minute'
      WHERE "id" = $1`, [blocked.waitId])
    const parallel = await seedWait(pool, userId, `${suffix}-parallel`, true)
    await setSessionDue(pool, parallel, 90)
    const targetLock = await pool.connect()
    let first: ReturnType<typeof observeTargetRead> | undefined
    try {
      await targetLock.query("BEGIN")
      await targetLock.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 FOR UPDATE`,
        [parallel.targetTaskId, parallel.sessionId])
      first = observeTargetRead(pool, 1)
      await waitForSignal(first.targetReadReached, "First poller did not reach its target read")
      const second = await reconcileDurableSubagentWaits(pool, { batchSize: 1 })
      expect(second).toEqual({ scanned: 0, resolved: 0, woken: 0 })
      expect(first.targetReadReturned()).toBe(false)
      await targetLock.query("COMMIT")
      await expect(first.completion).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    } finally {
      await targetLock.query("ROLLBACK").catch(() => undefined)
      targetLock.release()
      await first?.completion.catch(() => undefined)
    }
    const dispatch = await pool.query<{ count: number; status: string }>(
      `SELECT COUNT(*)::int AS "count", (SELECT "status" FROM "agent_wait_conditions" WHERE "id" = $2) AS "status"
        FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`subagent-dispatch:${parallel.parentTaskId}`, parallel.waitId])
    expect(dispatch.rows[0]).toEqual({ count: 1, status: "ready" })
  }, 90_000)

  it("keeps schedule durable across a fresh pool and rolls back an uncommitted schedule update", async () => {
    const suffix = randomUUID()
    const fixture = await seedWait(pool, userId, `${suffix}-restart`, false)
    const first = await reconcileDurableSubagentWaits(pool, { batchSize: 1 })
    expect(first).toMatchObject({ scanned: 1, resolved: 0, woken: 0 })
    const restartedPool = new Pool({ connectionString: databaseUrl!, max: 2 })
    try {
      const persisted = await restartedPool.query<{ scheduled: boolean }>(
        `SELECT "nextReconcileAt" IS NOT NULL AS "scheduled" FROM "agent_wait_conditions" WHERE "id" = $1`, [fixture.waitId])
      expect(persisted.rows[0]?.scheduled).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 5_100))
      await completeTarget(restartedPool, new PgSubagentTaskStore(restartedPool, 60_000), fixture,
        { ...defaultSubagentPolicy(), maxAttempts: 1 }, `${suffix}-restart-target`)
      expect((await reconcileDurableSubagentWaits(restartedPool, { batchSize: 1 })).woken).toBe(1)
    } finally { await restartedPool.end() }

    const rollbackFixture = await seedWait(pool, userId, `${suffix}-rollback`, false)
    const rollbackPool: Pick<Pool, "connect"> = {
      connect: async () => {
        const client = await pool.connect()
        let failCommit = true
        return {
          query: (text: string, values?: unknown[]) => {
            if (failCommit && text === "COMMIT") { failCommit = false; return Promise.reject(new Error("fixture_commit_failure")) }
            return client.query(text, values as never)
          },
          release: () => client.release(),
        } as unknown as PoolClient
      },
    }
    await expect(reconcileDurableSubagentWaits(rollbackPool, { batchSize: 1 })).rejects.toThrow("fixture_commit_failure")
    const rolledBack = await pool.query<{ nextReconcileAt: Date | null; status: string }>(
      `SELECT "nextReconcileAt", "status" FROM "agent_wait_conditions" WHERE "id" = $1`, [rollbackFixture.waitId])
    expect(rolledBack.rows[0]).toEqual({ nextReconcileAt: null, status: "waiting" })
  }, 90_000)

  it("rechecks a blocked wait deadline and commits one timeout dispatch without graph lifecycle events", async () => {
    const suffix = randomUUID()
    const fixture = await seedWait(pool, userId, `${suffix}-deadline-race`, false)
    const store = new PgSubagentTaskStore(pool, 60_000)
    await completeTarget(pool, store, fixture, { ...defaultSubagentPolicy(), maxAttempts: 1 }, `${suffix}-deadline-race`)

    const targetLock = await pool.connect()
    let reconcile: Promise<{ scanned: number; resolved: number; woken: number }> | undefined
    try {
      await targetLock.query("BEGIN")
      await targetLock.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 FOR UPDATE`,
        [fixture.targetTaskId, fixture.sessionId])
      await pool.query(`WITH deadline AS (SELECT timezone('UTC', clock_timestamp()) + INTERVAL '3 seconds' AS "value")
        UPDATE "agent_wait_conditions" AS wait SET "deadlineAt" = deadline."value", "nextReconcileAt" = NULL,
          "result" = jsonb_set(jsonb_set(wait."result", '{request,timeoutMs}', '3000'::jsonb),
            '{outcome,deadlineAt}', to_jsonb(to_char(deadline."value", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
        FROM deadline WHERE wait."id" = $1 AND wait."sessionId" = $2 AND wait."status" = 'waiting' AND wait."consumedAt" IS NULL`,
      [fixture.waitId, fixture.sessionId])

      const observing = observeTargetRead(pool, 1)
      reconcile = observing.completion
      await waitForSignal(observing.targetReadReached, "Resolver did not reach its target read")
      const beforeDeadline = await pool.query<{ beforeDeadline: boolean }>(`SELECT wait."deadlineAt" > timezone('UTC', clock_timestamp()) AS "beforeDeadline"
        FROM "agent_wait_conditions" AS wait WHERE wait."id" = $1`, [fixture.waitId])
      expect(beforeDeadline.rows[0]?.beforeDeadline).toBe(true)

      await waitForDeadline(pool, fixture.waitId)
      expect(observing.targetReadReturned()).toBe(false)
      await targetLock.query("COMMIT")

      await expect(reconcile).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
      const persisted = await pool.query<{ waitStatus: string; receiptStatus: string; matchedTaskIds: string[]; targetStatus: string;
        parentStatus: string; resolvedAfterDeadline: boolean; lifecycleEventCount: number; lifecycleEventOutboxCount: number; dispatchCount: number }>(
        `SELECT wait."status" AS "waitStatus",
          wait."result"->'outcome'->>'status' AS "receiptStatus", wait."matchedTaskIds" AS "matchedTaskIds",
          target."status" AS "targetStatus", parent."status" AS "parentStatus",
          wait."resolvedAt" >= wait."deadlineAt" AS "resolvedAfterDeadline",
          (SELECT COUNT(*)::int FROM "agent_events" AS event WHERE event."sessionId" = wait."sessionId"
            AND event."turnId" = wait."turnId" AND event."taskId" = wait."parentTaskId" AND event."type" = 'item.delta'
            AND event."payload"->'event'->>'type' = 'task.queued') AS "lifecycleEventCount",
          (SELECT COUNT(*)::int FROM "agent_events" AS event JOIN "agent_outbox" AS eventOutbox
            ON eventOutbox."topic" = 'agent.session.event' AND eventOutbox."payload"->>'eventId' = event."id"
            WHERE event."sessionId" = wait."sessionId" AND event."turnId" = wait."turnId"
              AND event."taskId" = wait."parentTaskId" AND event."type" = 'item.delta'
              AND event."payload"->'event'->>'type' = 'task.queued') AS "lifecycleEventOutboxCount",
          (SELECT COUNT(*)::int FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = $1) AS "dispatchCount"
        FROM "agent_wait_conditions" AS wait
        JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId" AND parent."sessionId" = wait."sessionId"
        JOIN "sub_agent_tasks" AS target ON target."id" = $2 AND target."sessionId" = wait."sessionId"
        WHERE wait."id" = $3 AND wait."sessionId" = $4`,
      [`subagent-dispatch:${fixture.parentTaskId}`, fixture.targetTaskId, fixture.waitId, fixture.sessionId])
      expect(persisted.rows[0]).toEqual({ waitStatus: "timed_out", receiptStatus: "timed_out",
        matchedTaskIds: [fixture.targetTaskId], targetStatus: "completed", parentStatus: "queued", resolvedAfterDeadline: true,
        lifecycleEventCount: 0, lifecycleEventOutboxCount: 0, dispatchCount: 1 })
      const dispatch = await pool.query<{ topic: string; aggregateId: string; idempotencyKey: string; taskId: string;
        sessionId: string; rootTaskId: string; publishedAt: Date | null }>(
        `SELECT "topic", "aggregateId", "idempotencyKey", "payload"->>'taskId' AS "taskId",
          "payload"->>'sessionId' AS "sessionId", "payload"->>'rootTaskId' AS "rootTaskId", "publishedAt"
         FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $1`,
        [`subagent-dispatch:${fixture.parentTaskId}`])
      expect(dispatch.rows).toEqual([{ topic: "agent.subagent.dispatch", aggregateId: fixture.sessionId,
        idempotencyKey: `subagent-dispatch:${fixture.parentTaskId}`, taskId: fixture.parentTaskId,
        sessionId: fixture.sessionId, rootTaskId: fixture.rootTaskId, publishedAt: null }])
    } finally {
      await targetLock.query("ROLLBACK").catch(() => undefined)
      targetLock.release()
      await reconcile?.catch(() => undefined)
    }
  }, 90_000)

  it("uses the UTC timestamp domain when scanning and expiring under a non-UTC database session zone", async () => {
    const fixture = await seedWait(pool, userId, `non-utc-${randomUUID()}`, false)
    const expectedDeadlineAt = "2026-06-15T12:00:00.000Z"
    await pool.query(`UPDATE "agent_wait_conditions" AS wait SET "suspendedAt" = TIMESTAMP '2026-06-14 12:00:00.000',
        "deadlineAt" = TIMESTAMP '2026-06-15 12:00:00.000',
        "nextReconcileAt" = NULL,
        "result" = jsonb_set(jsonb_set(wait."result", '{request,timeoutMs}', '86400000'::jsonb), '{outcome,deadlineAt}',
          to_jsonb('2026-06-15T12:00:00.000Z'::text))
      WHERE wait."id" = $1 AND wait."sessionId" = $2 AND wait."status" = 'waiting' AND wait."consumedAt" IS NULL`,
    [fixture.waitId, fixture.sessionId])

    let activeZone = ""
    const zonedPool: Pick<Pool, "connect"> = {
      connect: async () => {
        const client = await pool.connect()
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (sql === "BEGIN") {
              const result = await client.query(sql)
              const zone = await client.query<{ value: string }>(`SELECT set_config('TimeZone', $1, true) AS "value"`, ["Pacific/Honolulu"])
              activeZone = zone.rows[0]?.value ?? ""
              return result
            }
            return client.query(sql, values as never)
          },
          release: () => client.release(),
        } as unknown as PoolClient
      },
    }

    await expect(reconcileDurableSubagentWaits(zonedPool, { batchSize: 1 })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(activeZone).toBe("Pacific/Honolulu")
    const state = await pool.query<{ waitStatus: string; receiptStatus: string; receiptDeadlineAt: string;
      persistedDeadlineAt: string; parentStatus: string; dispatchCount: number }>(
      `SELECT wait."status" AS "waitStatus", wait."result"->'outcome'->>'status' AS "receiptStatus", parent."status" AS "parentStatus",
        wait."result"->'outcome'->>'deadlineAt' AS "receiptDeadlineAt",
        to_char(wait."deadlineAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "persistedDeadlineAt",
        (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "idempotencyKey" = $1) AS "dispatchCount"
       FROM "agent_wait_conditions" AS wait JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId" AND parent."sessionId" = wait."sessionId"
       WHERE wait."id" = $2 AND wait."sessionId" = $3`,
      [`subagent-dispatch:${fixture.parentTaskId}`, fixture.waitId, fixture.sessionId])
    expect(state.rows[0]).toEqual({ waitStatus: "timed_out", receiptStatus: "timed_out", receiptDeadlineAt: expectedDeadlineAt,
      persistedDeadlineAt: expectedDeadlineAt, parentStatus: "queued", dispatchCount: 1 })
  }, 90_000)

  it("times out an expired legacy NULL-schedule wait once and persists one parent dispatch", async () => {
    const fixture = await seedWait(pool, userId, `timeout-${randomUUID()}`, false)
    await pool.query(`UPDATE "agent_wait_conditions" SET "deadlineAt" = timezone('UTC', clock_timestamp()) - INTERVAL '1 millisecond',
        "nextReconcileAt" = NULL WHERE "id" = $1`, [fixture.waitId])
    const result = await reconcileDurableSubagentWaits(pool, { batchSize: 1 })
    expect(result).toMatchObject({ scanned: 1, resolved: 1, woken: 1 })
    const state = await pool.query<{ waitStatus: string; scheduledAt: Date | null; parentStatus: string; dispatchCount: number }>(
      `SELECT wait."status" AS "waitStatus", wait."nextReconcileAt" AS "scheduledAt", parent."status" AS "parentStatus",
        (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "idempotencyKey" = $1) AS "dispatchCount"
        FROM "agent_wait_conditions" AS wait JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId"
        WHERE wait."id" = $2 AND parent."sessionId" = $3`,
      [`subagent-dispatch:${fixture.parentTaskId}`, fixture.waitId, fixture.sessionId])
    expect(state.rows[0]).toEqual({ waitStatus: "timed_out", scheduledAt: null, parentStatus: "queued", dispatchCount: 1 })
  }, 90_000)
})
