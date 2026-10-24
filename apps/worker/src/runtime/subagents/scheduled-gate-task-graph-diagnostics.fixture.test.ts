import { describe, expect, it, vi } from "vitest"
import { classifyScheduledGateFinishQuery, createScheduledGateFinishDiagnosticPool, isScheduledGateFailureReason,
  withScheduledGateFinishTrace } from "./scheduled-gate-task-graph-diagnostics.fixture.js"

const identityQuery = `SELECT task."turnId", task."rootTaskId", task."parentTaskId", task."attemptCount", session."userId"
  FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"`
const gateLeaseQuery = `SELECT "status", "attemptCount", "maxAttempts", "role", "taskType",
  "leaseExpiresAt" > clock_timestamp() AS "leaseValid" FROM "sub_agent_tasks"`
const registrationQuery = `SELECT event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload",
  EXISTS (SELECT 1 FROM "agent_outbox") AS "hasOutbox" FROM "agent_events" AS event`
const stageQueries = [
  gateLeaseQuery,
  `SELECT "id", "status", "attemptCount", "state" FROM "agent_executions"`,
  `SELECT session."id" FROM "agent_sessions" AS session JOIN "agent_turns" AS turn ON true JOIN "sub_agent_tasks" AS root ON true`,
  registrationQuery,
  `SELECT "id", "stepId" FROM "agent_wait_conditions"`,
  `SELECT "id", "taskId", "attempt" FROM "agent_steps"`,
  `SELECT "id" FROM "agent_artifact_version"`,
]
const queryResult = { rows: [{ marker: "same" }], rowCount: 1 }

describe("scheduled Gate TaskGraph finish diagnostics", () => {
  it("classifies only fixed SQL shapes and fixed persisted reason codes", () => {
    expect(stageQueries.map(classifyScheduledGateFinishQuery)).toEqual([
      "gate_lease", "execution", "turn", "registration", "prepare_wait", "prepare_step", "prepare_prefix",
    ])
    expect(classifyScheduledGateFinishQuery("SELECT secret FROM private_table")).toBeNull()
    expect(isScheduledGateFailureReason("scheduled_gate_result_invalid")).toBe(true)
    expect(isScheduledGateFailureReason("database-provided-private-message")).toBe(false)
  })

  it("preserves connect, query, error, and release forwarding", async () => {
    const query = vi.fn(async function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(client)
      expect(args).toEqual(["SELECT 1", ["arg"]])
      return queryResult
    })
    const release = vi.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(client)
      expect(args).toEqual([releaseError])
    })
    const client = { query, release }
    const connectOptions = { applicationName: "fixture" }
    const connect = vi.fn(async function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(pool)
      expect(args).toEqual([connectOptions])
      return client
    })
    const pool = { connect }
    const wrapped = createScheduledGateFinishDiagnosticPool(pool)
    const releaseError = new Error("fixture release")
    const result = await withScheduledGateFinishTrace(async () => {
      const connected = await wrapped.connect(connectOptions)
      const queryValue = await connected.query("SELECT 1", ["arg"])
      connected.release(releaseError)
      return queryValue
    })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, value: queryResult, stage: "pre_query_guard" })

    const queryError = new Error("fixture query")
    const errorClient = { query: vi.fn(async (..._args: unknown[]) => { throw queryError }), release: vi.fn() }
    const errorPool = createScheduledGateFinishDiagnosticPool({ connect: vi.fn(async () => errorClient) })
    const connected = await errorPool.connect()
    await expect(connected.query("SELECT 2")).rejects.toBe(queryError)
  })

  it("preserves callback-style connect receiver, client query, and supplied release callback", async () => {
    const query = vi.fn(async function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(client)
      expect(args).toEqual(["SELECT callback"])
      return queryResult
    })
    const client = { query, release: vi.fn() }
    const options = { applicationName: "callback-fixture" }
    const release = vi.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBeUndefined()
      expect(args).toEqual([releaseError])
    })
    const connect = vi.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(pool)
      expect(args[0]).toBe(options)
      const callback = args[1]
      if (typeof callback !== "function") throw new Error("callback_missing")
      queueMicrotask(() => Reflect.apply(callback, this, [null, client, release]))
    })
    const pool = { connect }
    const wrapped = createScheduledGateFinishDiagnosticPool(pool)
    const releaseError = new Error("callback release")
    const completed = new Promise<void>((resolve, reject) => {
      wrapped.connect(options, function (this: unknown, ...args: unknown[]) {
        try {
          expect(this).toBe(pool)
          expect(args[0]).toBeNull()
          const connected = args[1] as typeof client
          const done = args[2] as (...values: unknown[]) => unknown
          expect(connected).not.toBe(client)
          expect(done).toBe(release)
          void connected.query("SELECT callback").then(() => { done(releaseError); resolve() }, reject)
        } catch (error: unknown) { reject(error) }
      })
    })
    await completed
    expect(query).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("keeps the deepest validator stage across lower-stage fallback reads and freezes before rejection transition", async () => {
    const client = { query: vi.fn(async (..._args: unknown[]) => queryResult), release: vi.fn() }
    const pool = { connect: vi.fn(async () => client) }
    const wrapped = createScheduledGateFinishDiagnosticPool(pool)
    const result = await withScheduledGateFinishTrace(async () => {
      const db = await wrapped.connect()
      await db.query(identityQuery)
      for (const sql of stageQueries) await db.query(sql)
      await db.query(stageQueries[4])
      await db.query(identityQuery)
      await db.query(gateLeaseQuery)
    })
    expect(result).toMatchObject({ ok: true, stage: "prepare_prefix" })
  })

  it("reports a pre-query guard when rejection follows graph preparation without the Gate lease query", async () => {
    const client = { query: vi.fn(async (..._args: unknown[]) => queryResult), release: vi.fn() }
    const wrapped = createScheduledGateFinishDiagnosticPool({ connect: vi.fn(async () => client) })
    const result = await withScheduledGateFinishTrace(async () => {
      const db = await wrapped.connect()
      await db.query(identityQuery)
      await db.query(identityQuery)
    })
    expect(result).toMatchObject({ ok: true, stage: "pre_query_guard" })
  })

  it("ignores an independent in-flight heartbeat query and retains stage on validator error", async () => {
    let releaseHeartbeat!: () => void
    let heartbeatStarted!: () => void
    const waiting = new Promise<void>(resolve => { releaseHeartbeat = resolve })
    const started = new Promise<void>(resolve => { heartbeatStarted = resolve })
    const client = { query: vi.fn(async (sql: unknown, ..._args: unknown[]) => {
      if (sql === "HEARTBEAT") { heartbeatStarted(); await waiting }
      return queryResult
    }), release: vi.fn() }
    const wrapped = createScheduledGateFinishDiagnosticPool({ connect: vi.fn(async () => client) })
    const dbOutsideTrace = await wrapped.connect()
    const heartbeat = dbOutsideTrace.query("HEARTBEAT")
    await started
    const validationError = new Error("validator stopped")
    const result = await withScheduledGateFinishTrace(async () => {
      const db = await wrapped.connect()
      await db.query(gateLeaseQuery)
      await db.query(stageQueries[1])
      releaseHeartbeat()
      await heartbeat
      throw validationError
    })
    expect(result).toEqual({ ok: false, error: validationError, stage: "execution" })
  })
})
