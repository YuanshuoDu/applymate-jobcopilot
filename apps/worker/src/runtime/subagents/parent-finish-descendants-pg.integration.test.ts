import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"

import { AgentTreeManager } from "./manager.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { SubagentLeaseError, type PgSubagentPool, type SubagentLease, type SubagentTaskSpec } from "./types.js"

// Never fall back to DATABASE_URL: this suite mutates disposable PostgreSQL fixtures only.
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
    throw new Error("Parent finish descendants require the dedicated disposable CI PostgreSQL service")
  }
  return value
}

const url = disposableUrl()
const describePg = url ? describe : describe.skip
type Fixture = { userId: string; sessionId: string; turnId: string; rootId: string; parentId: string }

function fixture(): Fixture {
  const id = randomUUID()
  return { userId: `finish-user-${id}`, sessionId: `finish-session-${id}`, turnId: `finish-turn-${id}`,
    rootId: `finish-root-${id}`, parentId: `finish-parent-${id}` }
}

async function seed(pool: Pool, f: Fixture): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [f.userId, `${f.userId}@example.invalid`])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Finish descendant fixture', 'running', 'test', CURRENT_TIMESTAMP)`, [f.sessionId, f.userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
      "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [f.turnId, f.sessionId, f.userId])
  const columns = `("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType",
    "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")`
  await pool.query(`INSERT INTO "sub_agent_tasks" ${columns} VALUES
    ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'root', '{}'::jsonb, '[]'::jsonb,
      '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 3, CURRENT_TIMESTAMP)`,
  [f.rootId, f.sessionId, f.turnId])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [f.rootId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [f.rootId, f.turnId])
  await pool.query(`INSERT INTO "sub_agent_tasks" ${columns} VALUES
    ($1, $2, $3, $4, $4, '/root/parent', 1, 'scout', 'research', 'queued', 'parent', '{}'::jsonb, '[]'::jsonb,
      '["jobs.search"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 3, CURRENT_TIMESTAMP)`,
  [f.parentId, f.sessionId, f.turnId, f.rootId])
}

async function insertDescendant(pool: Pool, f: Fixture, input: {
  id: string; parentTaskId: string; path: string; depth: number; status: "running" | "completed";
}): Promise<void> {
  await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path",
      "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context",
      "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'scout', 'research', $8, 'descendant', '{}'::jsonb, '[]'::jsonb,
      '["jobs.search"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP)`,
  [input.id, f.sessionId, f.turnId, f.rootId, input.parentTaskId, input.path, input.depth, input.status])
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

function capture<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
}

describePg("parent finish descendant barrier: disposable PostgreSQL", () => {
  let pool: Pool
  let value: Fixture
  let store: PgSubagentTaskStore
  let lease: SubagentLease
  const parentOwner = "finish-parent-worker"

  beforeAll(() => { pool = new Pool({ connectionString: url!, max: 8 }) })
  beforeEach(async () => {
    value = fixture()
    await seed(pool, value)
    store = new PgSubagentTaskStore(pool)
    const claimed = await store.claim({ taskId: value.parentId, sessionId: value.sessionId, ownerId: parentOwner,
      policy: { maxConcurrency: 4, maxDepth: 2, maxFanOut: 2, maxAttempts: 3 }, now: new Date() })
    if (!claimed?.leaseExpiresAt) throw new Error("Fixture parent could not be claimed")
    lease = { ...claimed, ownerId: parentOwner, leaseExpiresAt: claimed.leaseExpiresAt, signal: new AbortController().signal }
  })
  afterEach(async () => { if (value) await clean(pool, value) })
  afterAll(async () => { await pool.end() })

  it.each(["direct active child", "active grandchild below a terminal child"] as const)(
    "returns children_pending without persisting success when a %s exists", async kind => {
      const childId = `finish-child-${randomUUID()}`
      if (kind === "direct active child") {
        await insertDescendant(pool, value, { id: childId, parentTaskId: value.parentId, path: `/root/parent/${childId}`, depth: 2, status: "running" })
      } else {
        await insertDescendant(pool, value, { id: childId, parentTaskId: value.parentId, path: `/root/parent/${childId}`, depth: 2, status: "completed" })
        const grandchildId = `finish-grandchild-${randomUUID()}`
        await insertDescendant(pool, value, { id: grandchildId, parentTaskId: childId, path: `/root/parent/${childId}/${grandchildId}`, depth: 3, status: "running" })
      }
      const before = (await pool.query(`SELECT "status", "result", "leaseOwner", "completedAt" FROM "sub_agent_tasks" WHERE "id" = $1`,
        [value.parentId])).rows[0]

      await expect(store.finish({ taskId: lease.id, sessionId: lease.sessionId, ownerId: lease.ownerId,
        attemptCount: lease.attemptCount, status: "completed", result: { status: "completed", text: "done" },
        mailboxMessageIds: [], now: new Date() })).resolves.toEqual({ status: "children_pending" })

      const after = (await pool.query(`SELECT "status", "result", "leaseOwner", "completedAt" FROM "sub_agent_tasks" WHERE "id" = $1`,
        [value.parentId])).rows[0]
      expect(after).toEqual(before)
      const completionEvents = await pool.query(`SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "taskId" = $2
        AND "type" = 'task.completed'`, [value.sessionId, value.parentId])
      expect(completionEvents.rowCount).toBe(0)
      const mailbox = await pool.query(`SELECT 1 FROM "agent_mailbox_messages" WHERE "sessionId" = $1 AND "toTaskId" = $2
        AND "consumedAt" IS NOT NULL`, [value.sessionId, value.parentId])
      expect(mailbox.rowCount).toBe(0)
    },
  )

  it("keeps stale owners fenced instead of reporting children_pending", async () => {
    const childId = `finish-child-${randomUUID()}`
    await insertDescendant(pool, value, { id: childId, parentTaskId: value.parentId, path: `/root/parent/${childId}`, depth: 2, status: "running" })
    await expect(store.finish({ taskId: lease.id, sessionId: lease.sessionId, ownerId: "stale-owner",
      attemptCount: lease.attemptCount, status: "completed", result: { status: "completed" }, now: new Date() })).resolves.toBeNull()
    const parent = (await pool.query(`SELECT "status", "leaseOwner", "result" FROM "sub_agent_tasks" WHERE "id" = $1`,
      [value.parentId])).rows[0]
    expect(parent).toMatchObject({ status: "running", leaseOwner: parentOwner, result: null })
  })

  it("serializes a racing spawn and finish so a newly created descendant cannot slip through", async () => {
    const started = Date.now()
    const remaining = (max: number) => {
      const ms = started + 15_000 - Date.now()
      if (ms <= 0) throw new Error("Spawn/finish race deadline expired")
      return Math.min(max, ms)
    }
    const work = <T>(operation: () => Promise<T>, label: string) => bounded(operation(), remaining(2_000), label)
    let notifyLockRequests!: () => void
    const lockRequestsReady = new Promise<void>(resolve => { notifyLockRequests = resolve })
    const lockPids: number[] = []
    const owned = new Set<PoolClient>()
    let observerClosed = false
    const releaseOwned = (client: PoolClient, destroy = false) => { if (owned.delete(client)) client.release(destroy) }
    const observedPool: PgSubagentPool = { connect: async () => {
      const client = await boundedCheckout(pool, remaining(2_000))
      if (observerClosed) { client.release(true); throw new Error("Observer is closed") }
      owned.add(client)
      let pid: number
      try { pid = Number((await work(() => client.query(`SELECT pg_backend_pid() AS pid`), "Worker PID probe")).rows[0]!.pid) }
      catch (error) { releaseOwned(client, true); throw error }
      return new Proxy(client, { get(target, property) {
        if (property === "release") return () => releaseOwned(target)
        if (property !== "query") { const result = Reflect.get(target, property); return typeof result === "function" ? result.bind(target) : result }
        return (...args: unknown[]) => {
          const first = args[0]
          const sql = typeof first === "string" ? first : first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : ""
          const values = args[1]
          if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")
            && Array.isArray(values) && values[0] === value.sessionId) {
            lockPids.push(pid)
            if (lockPids.length === 2) notifyLockRequests()
          }
          return Reflect.apply(target.query, target, args)
        }
      } }) as PoolClient
    } }
    const racingStore = new PgSubagentTaskStore(observedPool)
    const racingManager = new AgentTreeManager(racingStore, { heartbeatMs: 300_000 })
    const blocker = await boundedCheckout(pool, remaining(2_000))
    const probe = await boundedCheckout(pool, remaining(2_000))
    let blockerOpen = false
    let probeOpen = true
    let pendingOperations: Promise<unknown>[] = []
    try {
      await work(() => blocker.query("BEGIN"), "Blocker begin")
      blockerOpen = true
      const blockerPid = Number((await work(() => blocker.query(`SELECT pg_backend_pid() AS pid`), "Blocker PID probe")).rows[0]!.pid)
      const blockerLock = await work(() => blocker.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [value.sessionId]), "Session lock")
      const blockerRowLocked = blockerLock.rowCount === 1
      expect(blockerRowLocked).toBe(true)
      const request: SubagentTaskSpec = { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        parentTaskId: value.parentId, role: "scout", taskType: "research", goal: "Concurrent read-only child",
        allowedActions: ["jobs.search"] }
      const spawn = capture(racingManager.spawnFromLease(request, `finish-race-${randomUUID()}`, lease))
      const finish = capture(racingStore.finish({ taskId: lease.id, sessionId: lease.sessionId, ownerId: lease.ownerId,
        attemptCount: lease.attemptCount, status: "completed", result: { status: "completed" }, now: new Date() }))
      pendingOperations = [spawn, finish]
      await bounded(lockRequestsReady, remaining(3_000), "Both session lock requests")
      const distinctWaiterPids = new Set(lockPids).size === 2
      expect(distinctWaiterPids).toBe(true)
      const deadline = Math.min(started + 12_000, Date.now() + 5_000)
      let bothBlocked = false
      let bothActiveLockWaiters = false
      let bothChainsReachBlocker = false
      while (Date.now() < deadline && !bothBlocked) {
        const status = await work(() => probe.query<{
          pid: number; state: string | null; waitEventType: string | null; blockingPids: number[]
        }>(`SELECT activity.pid, activity.state, activity.wait_event_type AS "waitEventType",
            pg_blocking_pids(activity.pid) AS "blockingPids"
          FROM pg_stat_activity AS activity WHERE activity.pid = ANY($1::int[])`, [lockPids]), "Session lock chain probe")
        const byPid = new Map(status.rows.map(row => [Number(row.pid), row]))
        const allowedPids = new Set([blockerPid, ...lockPids])
        const reachesBlocker = (pid: number, visited = new Set<number>()): boolean => {
          if (pid === blockerPid) return true
          if (visited.has(pid)) return false
          visited.add(pid)
          const row = byPid.get(pid)
          if (!row || row.state !== "active" || row.waitEventType !== "Lock" || !Array.isArray(row.blockingPids)) return false
          const blockers = row.blockingPids.map(Number)
          return blockers.length > 0 && blockers.every(blocker => allowedPids.has(blocker))
            && blockers.every(blocker => reachesBlocker(blocker, new Set(visited)))
        }
        bothActiveLockWaiters = lockPids.every(pid => {
          const row = byPid.get(pid)
          return row?.state === "active" && row.waitEventType === "Lock"
        })
        bothChainsReachBlocker = lockPids.every(pid => reachesBlocker(pid))
        bothBlocked = bothActiveLockWaiters && bothChainsReachBlocker
      }
      expect({ blockerRowLocked, distinctWaiterPids, bothActiveLockWaiters, bothChainsReachBlocker }).toEqual({
        blockerRowLocked: true, distinctWaiterPids: true, bothActiveLockWaiters: true, bothChainsReachBlocker: true,
      })
      await work(() => blocker.query("COMMIT"), "Blocker commit")
      blockerOpen = false
      const [spawned, finished] = await Promise.all([
        bounded(spawn, remaining(3_000), "Spawn result"), bounded(finish, remaining(3_000), "Finish result"),
      ])
      if (spawned.ok) {
        expect(spawned.value.task).toBeTruthy()
        expect(finished).toMatchObject({ ok: true, value: { status: "children_pending" } })
      } else {
        expect(spawned.error).toBeInstanceOf(SubagentLeaseError)
        expect(spawned.error).toMatchObject({ code: "lost" })
        expect(finished).toMatchObject({ ok: true, value: "completed" })
      }
      const parent = (await work(() => probe.query(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [value.parentId]),
        "Final parent state")).rows[0]
      const children = await work(() => probe.query(`SELECT "status" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2`,
        [value.sessionId, value.parentId]), "Final child state")
      if (spawned.ok) {
        expect(parent?.status).toBe("running")
        expect(children.rows).toHaveLength(1)
      } else {
        expect(parent?.status).toBe("completed")
        expect(children.rows).toHaveLength(0)
      }
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined)
      blocker.release()
      const cleanupRemaining = () => Math.max(1, Math.min(2_000, started + 18_000 - Date.now()))
      try { await bounded(Promise.all(pendingOperations), cleanupRemaining(), "Spawn/finish race cleanup") }
      catch { observerClosed = true; for (const client of owned) releaseOwned(client, true) }
      if (probeOpen) { probeOpen = false; probe.release() }
      await bounded(racingManager.shutdown(), cleanupRemaining(), "Race manager shutdown")
      observerClosed = true
      for (const client of owned) releaseOwned(client, true)
    }
  }, 20_000)
})
