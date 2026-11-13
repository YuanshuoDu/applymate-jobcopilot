import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"

import { AgentTreeManager } from "./manager.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { SubagentLeaseError, type PgSubagentPool, type SubagentLease, type SubagentTaskSpec } from "./types.js"

// Never fall back to DATABASE_URL: this suite mutates its own disposable fixtures.
function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Required disposable PostgreSQL URL is missing")
    return null
  }
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "nested_fixture"
    || url.password !== "nested_fixture_only" || url.pathname !== "/applymate_nested_delegation_ci" || url.search || url.hash) {
    throw new Error("Parent execution fencing requires the dedicated disposable CI PostgreSQL service")
  }
  return value
}

const url = disposableUrl()
const describePg = url ? describe : describe.skip
type Fixture = { userId: string; sessionId: string; turnId: string; rootId: string; parentId: string }

function fixture(): Fixture {
  const id = randomUUID()
  return { userId: `fence-user-${id}`, sessionId: `fence-session-${id}`, turnId: `fence-turn-${id}`,
    rootId: `fence-root-${id}`, parentId: `fence-parent-${id}` }
}

async function seed(pool: Pool, f: Fixture): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [f.userId, `${f.userId}@example.invalid`])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Fence fixture', 'running', 'test', CURRENT_TIMESTAMP)`, [f.sessionId, f.userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [f.turnId, f.sessionId, f.userId])
  const columns = `("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")`
  await pool.query(`INSERT INTO "sub_agent_tasks" ${columns} VALUES
    ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'root', '{}'::jsonb, '[]'::jsonb, '["jobs.search"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 3, CURRENT_TIMESTAMP)`, [f.rootId, f.sessionId, f.turnId])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [f.rootId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [f.rootId, f.turnId])
  await pool.query(`INSERT INTO "sub_agent_tasks" ${columns} VALUES
    ($1, $2, $3, $4, $4, '/root/parent', 1, 'scout', 'research', 'queued', 'parent', '{}'::jsonb, '[]'::jsonb, '["jobs.search"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5::jsonb, 0, 3, CURRENT_TIMESTAMP)`,
  [f.parentId, f.sessionId, f.turnId, f.rootId, JSON.stringify({ subagentPolicy: { maxConcurrency: 4, maxDepth: 2, maxFanOut: 2, maxAttempts: 3 } })])
}

function spec(f: Fixture, policy?: SubagentTaskSpec["policy"]): SubagentTaskSpec {
  return { userId: f.userId, sessionId: f.sessionId, turnId: f.turnId, parentTaskId: f.parentId,
    role: "scout", taskType: "research", goal: "Read-only nested research", allowedActions: ["jobs.search"], ...(policy ? { policy } : {}) }
}

async function snapshot(pool: Pool, f: Fixture) {
  const children = await pool.query(`SELECT "id", "parentTaskId", "rootTaskId", "path", "depth", "status" FROM "sub_agent_tasks"
    WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`, [f.sessionId, f.parentId])
  const outbox = await pool.query(`SELECT "id", "topic", "idempotencyKey", "payload" FROM "agent_outbox"
    WHERE "aggregateId" = $1 AND "topic" IN ('agent.subagent.spawn', 'agent.subagent.dispatch') ORDER BY "id"`, [f.sessionId])
  return { children: children.rows, outbox: outbox.rows }
}

async function parentState(pool: Pool, f: Fixture) {
  return (await pool.query(`SELECT "status", "leaseOwner", "leaseExpiresAt", "attemptCount", "interruptRequestedAt"
    FROM "sub_agent_tasks" WHERE "id" = $1`, [f.parentId])).rows[0]
}

async function clean(pool: Pool, f: Fixture): Promise<void> {
  await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [f.sessionId])
  await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [f.userId])
}

function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
  })]).finally(() => { if (timer) clearTimeout(timer) })
}

// A checkout arriving after its deadline is returned, never handed to a finished test.
function boundedCheckout(pool: Pool, ms = 2_000): Promise<PoolClient> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => { settled = true; reject(new Error("PostgreSQL checkout timed out")) }, ms)
    void Promise.resolve().then(() => pool.connect()).then(client => {
      if (settled) { client.release(true); return }
      settled = true; clearTimeout(timer); resolve(client)
    }, error => {
      if (settled) return
      settled = true; clearTimeout(timer); reject(error)
    }).catch(() => undefined)
  })
}

describePg("parent execution fence: disposable PostgreSQL primitive", () => {
  let pool: Pool
  let f: Fixture
  let manager: AgentTreeManager
  let lease: SubagentLease

  beforeAll(() => { pool = new Pool({ connectionString: url!, max: 5 }) })
  beforeEach(async () => {
    f = fixture()
    await seed(pool, f)
    manager = new AgentTreeManager(new PgSubagentTaskStore(pool), { heartbeatMs: 300_000 })
    const claimed = await manager.claim({ taskId: f.parentId, sessionId: f.sessionId, rootTaskId: f.rootId, ownerId: "fence-worker" })
    if (!claimed) throw new Error("Fixture parent could not be claimed")
    lease = claimed
  })
  afterEach(async () => {
    try { await manager?.shutdown() } finally { if (f) await clean(pool, f) }
  })
  afterAll(async () => { await pool.end() })

  it("creates a depth-two child and dispatch under the current parent lease", async () => {
    const result = await manager.spawnFromLease(spec(f), "first", lease)
    expect(result).toMatchObject({ atomic: true, duplicate: false, task: { depth: 2, parentTaskId: f.parentId, rootTaskId: f.rootId } })
    expect(result.task?.path).toBe(`/root/parent/${result.task?.id}`)
    const state = await snapshot(pool, f)
    expect(state.children).toHaveLength(1)
    expect(state.outbox.filter(row => row.topic === "agent.subagent.spawn")).toHaveLength(1)
    expect(state.outbox.filter(row => row.topic === "agent.subagent.dispatch")).toHaveLength(1)
    expect(state.outbox.find(row => row.topic === "agent.subagent.dispatch")?.payload).toMatchObject({ taskId: result.task?.id, sessionId: f.sessionId, rootTaskId: f.rootId })
  })

  it("replays an exact idempotent spawn once for the current parent lease", async () => {
    const first = await manager.spawnFromLease(spec(f), "same", lease)
    const before = await snapshot(pool, f)
    const second = await manager.spawnFromLease(spec(f), "same", lease)
    expect(second).toMatchObject({ atomic: true, duplicate: true, task: { id: first.task?.id } })
    expect(await snapshot(pool, f)).toEqual(before)
    expect(before.children).toHaveLength(1)
    expect(before.outbox).toHaveLength(2)
  })

  it("rejects reclaimed owners and attempts before create or idempotent return", async () => {
    await manager.spawnFromLease(spec(f), "existing", lease)
    await pool.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $2, "attemptCount" = "attemptCount" + 1 WHERE "id" = $1`, [f.parentId, "new-owner"])
    const before = await snapshot(pool, f)
    for (const key of ["existing", "new"]) {
      await expect(manager.spawnFromLease(spec(f), key, lease)).rejects.toMatchObject({ name: "SubagentLeaseError", code: "lost" })
      expect(await snapshot(pool, f)).toEqual(before)
    }
    await expect(manager.spawnFromLease(spec(f), "attempt", { ...lease, ownerId: "new-owner" })).rejects.toMatchObject({ name: "SubagentLeaseError", code: "lost" })
    await expect(manager.spawnFromLease(spec(f), "owner", { ...lease, attemptCount: lease.attemptCount + 1 })).rejects.toMatchObject({ name: "SubagentLeaseError", code: "lost" })
    expect(await snapshot(pool, f)).toEqual(before)
  })

  it("rejects expired interrupted and terminal parent executions", async () => {
    await manager.spawnFromLease(spec(f), "existing", lease)
    for (const mutation of [
      `"leaseExpiresAt" = clock_timestamp() - interval '1 second'`,
      `"interruptRequestedAt" = clock_timestamp()`,
      `"status" = 'completed'`,
    ]) {
      await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "interruptRequestedAt" = NULL, "leaseExpiresAt" = clock_timestamp() + interval '10 minutes' WHERE "id" = $1`, [f.parentId])
      await pool.query(`UPDATE "sub_agent_tasks" SET ${mutation} WHERE "id" = $1`, [f.parentId])
      const before = await snapshot(pool, f)
      for (const key of ["existing", randomUUID()]) {
        await expect(manager.spawnFromLease(spec(f), key, lease)).rejects.toMatchObject({ name: "SubagentLeaseError", code: "lost" })
        expect(await snapshot(pool, f)).toEqual(before)
      }
    }
  })

  it("rejects foreign user session turn root and parent identities", async () => {
    const before = await snapshot(pool, f)
    const foreign = fixture()
    await seed(pool, foreign)
    const foreignBefore = await snapshot(pool, foreign)
    try {
      const cases: Array<[SubagentTaskSpec, SubagentLease]> = [
        [{ ...spec(f), userId: foreign.userId }, { ...lease, userId: foreign.userId }],
        [{ ...spec(f), sessionId: foreign.sessionId }, { ...lease, sessionId: foreign.sessionId }],
        [{ ...spec(f), turnId: foreign.turnId }, { ...lease, turnId: foreign.turnId }],
        [{ ...spec(f), parentTaskId: foreign.parentId }, { ...lease, id: foreign.parentId }],
        [spec(f), { ...lease, rootTaskId: foreign.rootId }],
      ]
      for (const [request, owner] of cases) {
        await expect(manager.spawnFromLease(request, randomUUID(), owner)).rejects.toMatchObject({ name: "SubagentLeaseError", code: "lost" })
        expect(await snapshot(pool, f)).toEqual(before)
        expect(await snapshot(pool, foreign)).toEqual(foreignBefore)
      }
    } finally {
      await clean(pool, foreign)
    }
  })

  it("enforces inherited depth and fan-out limits without partial dispatch", async () => {
    const parentPolicy = (maxDepth: number, maxFanOut: number) => JSON.stringify({ subagentPolicy: { maxConcurrency: 4, maxDepth, maxFanOut, maxAttempts: 3 } })
    await pool.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = $2::jsonb WHERE "id" = $1`, [f.parentId, parentPolicy(1, 2)])
    const empty = await snapshot(pool, f)
    await expect(manager.spawnFromLease(spec(f, { maxDepth: 8, maxFanOut: 8 }), "too-deep", lease)).rejects.toMatchObject({ code: "depth" })
    expect(await snapshot(pool, f)).toEqual(empty)
    await pool.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = $2::jsonb WHERE "id" = $1`, [f.parentId, parentPolicy(2, 1)])
    const child = await manager.spawnFromLease(spec(f, { maxDepth: 8, maxFanOut: 8 }), "one", lease)
    expect(child.task?.budgetSnapshot).toMatchObject({ subagentPolicy: { maxDepth: 2, maxFanOut: 1 } })
    const one = await snapshot(pool, f)
    await expect(manager.spawnFromLease(spec(f, { maxDepth: 8, maxFanOut: 8 }), "two", lease)).rejects.toMatchObject({ code: "fan_out" })
    expect(await snapshot(pool, f)).toEqual(one)
    expect(one.children).toHaveLength(1)
    expect(one.outbox).toHaveLength(2)
  })

  it("fences an owner change while atomic creation waits for the session lock", async () => {
    const started = Date.now()
    const remaining = (max: number) => {
      const ms = started + 12_000 - Date.now()
      if (ms <= 0) throw new Error("Race work deadline expired")
      return Math.min(max, ms)
    }
    const work = <T>(operation: () => Promise<T>, label: string) => {
      const ms = remaining(2_000)
      return bounded(operation(), ms, label)
    }
    const raceSnapshot = async (client: PoolClient) => {
      const children = await client.query(`SELECT "id", "parentTaskId", "rootTaskId", "path", "depth", "status" FROM "sub_agent_tasks"
        WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`, [f.sessionId, f.parentId])
      const outbox = await client.query(`SELECT "id", "topic", "idempotencyKey", "payload" FROM "agent_outbox"
        WHERE "aggregateId" = $1 AND "topic" IN ('agent.subagent.spawn', 'agent.subagent.dispatch') ORDER BY "id"`, [f.sessionId])
      return { children: children.rows, outbox: outbox.rows }
    }
    let observed!: (pid: number) => void
    const sessionQueryStarted = new Promise<number>(resolve => { observed = resolve })
    const owned = new Set<PoolClient>()
    let observerClosed = false
    const releaseOwned = (client: PoolClient, destroy = false) => {
      if (owned.delete(client)) client.release(destroy)
    }
    const observedPool: PgSubagentPool = { connect: async () => {
      const client = await boundedCheckout(pool, remaining(2_000))
      if (observerClosed) { client.release(true); throw new Error("Observer is closed") }
      owned.add(client)
      let pid: number
      try {
        pid = Number((await work(() => client.query(`SELECT pg_backend_pid() AS pid`), "Observer PID probe")).rows[0].pid)
        if (observerClosed) throw new Error("Observer is closed")
      } catch (error) { releaseOwned(client, true); throw error }
      return new Proxy(client, { get(target, property) {
        if (property === "release") return () => releaseOwned(target)
        if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value }
        return (...args: unknown[]) => {
          const result = Reflect.apply(target.query, target, args)
          const sql = typeof args[0] === "string" ? args[0] : ""
          if (sql.includes('"agent_sessions"') && sql.includes("FOR UPDATE")) observed(pid)
          return result
        }
      } }) as PoolClient
    } }
    const racingManager = new AgentTreeManager(new PgSubagentTaskStore(observedPool))
    let outcome: Promise<{ value: unknown } | { error: unknown }> | undefined
    let blocker: PoolClient | undefined
    let probe: PoolClient | undefined
    let probeOwned = false
    let blockerOwned = false
    try {
      probe = await boundedCheckout(pool, remaining(2_000))
      probeOwned = true
      const before = await work(() => raceSnapshot(probe!), "Initial snapshot")
      blocker = await boundedCheckout(pool, remaining(2_000))
      blockerOwned = true
      await work(() => blocker!.query("BEGIN"), "Blocker begin")
      const blockerPid = Number((await work(() => blocker!.query(`SELECT pg_backend_pid() AS pid`), "Blocker PID probe")).rows[0].pid)
      await work(() => blocker!.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [f.sessionId]), "Session lock")
      const spawn = racingManager.spawnFromLease(spec(f), "race", lease)
      // Attach rejection handling immediately while the observer confirms the actual lock wait.
      outcome = spawn.then(value => ({ value }), error => ({ error }))
      const pid = await bounded(sessionQueryStarted, remaining(3_000), "Session lock query")
      const deadline = Math.min(Date.now() + 5_000, started + 12_000)
      let blocked = false
      while (Date.now() < deadline && !blocked) {
        try {
          const result = await work(() => probe!.query<{ blocked: boolean }>(`SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`, [pid, blockerPid]), "Lock wait probe")
          blocked = result.rows[0]?.blocked === true
        } catch (error) { if (probeOwned) { probeOwned = false; probe?.release(true) }; throw error }
      }
      expect(blocked).toBe(true)
      await work(() => blocker!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $2, "attemptCount" = "attemptCount" + 1 WHERE "id" = $1`, [f.parentId, "reclaimed-owner"]), "Owner update")
      await work(() => blocker!.query("COMMIT"), "Blocker commit")
      const result = await bounded(outcome, remaining(3_000), "Spawn result")
      expect(result).toHaveProperty("error")
      if ("error" in result) expect(result.error).toBeInstanceOf(SubagentLeaseError)
      if ("error" in result) expect(result.error).toMatchObject({ code: "lost" })
      expect(await work(() => raceSnapshot(probe!), "Final snapshot")).toEqual(before)
    } finally {
      const cleanupRemaining = () => Math.max(1, Math.min(2_000, started + 18_000 - Date.now()))
      if (blockerOwned && blocker) {
        try { await bounded(blocker.query("ROLLBACK"), cleanupRemaining(), "Blocker rollback") }
        catch { blockerOwned = false; blocker.release(true) }
        if (blockerOwned) { blockerOwned = false; blocker.release() }
      }
      if (probeOwned) { probeOwned = false; probe?.release(true) }
      if (outcome) {
        try { await bounded(outcome, cleanupRemaining(), "Spawn cleanup") }
        catch { observerClosed = true; for (const client of owned) releaseOwned(client, true) }
      }
      observerClosed = true
      for (const client of owned) releaseOwned(client, true)
      await bounded(racingManager.shutdown(), cleanupRemaining(), "Race manager shutdown")
    }
  }, 20_000)

  it("rejects aborted execution without changing the current parent or dispatch", async () => {
    const before = await snapshot(pool, f)
    const parent = await parentState(pool, f)
    const controller = new AbortController()
    controller.abort()
    await expect(manager.spawnFromLease(spec(f), "aborted", { ...lease, signal: controller.signal })).rejects.toMatchObject({ name: "SubagentLeaseError", code: "lost" })
    // Hide only the optional capability on the real store to prove there is no unfenced fallback.
    const store = new PgSubagentTaskStore(pool)
    const withoutCapability = new Proxy(store, { get(target, property) {
      if (property === "createWithSpawnFromLease") return undefined
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const unavailable = new AgentTreeManager(withoutCapability)
    await expect(unavailable.spawnFromLease(spec(f), "unavailable", lease)).rejects.toMatchObject({ name: "SubagentLeaseError", code: "not_available" })
    await unavailable.shutdown()
    expect(await parentState(pool, f)).toEqual(parent)
    expect(await snapshot(pool, f)).toEqual(before)
  })
})
