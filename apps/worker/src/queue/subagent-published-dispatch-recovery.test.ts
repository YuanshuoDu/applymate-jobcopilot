import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { recoverMissingPublishedSubagentDispatches } from "./subagent-published-dispatch-recovery.js"
import { subagentDispatchJobId } from "../runtime/subagents/dispatch-identity.js"
import type { PgSubagentPool } from "../runtime/subagents/types.js"

const payload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "owner-1" }

function snapshotRow(taskId = payload.taskId) {
  const publishedAt = new Date(Date.now() - 120_000)
  return {
    dispatchId: `dispatch-${taskId}`, topic: "agent.subagent.dispatch", aggregateId: payload.sessionId,
    idempotencyKey: `subagent-dispatch:${taskId}`, payload: { ...payload, taskId }, attemptCount: 2,
    publishedAt, publishedAtText: publishedAt.toISOString(), taskId, sessionId: payload.sessionId,
    turnId: "turn-1", rootTaskId: payload.rootTaskId, turnRootTaskId: payload.rootTaskId,
    userId: "user-1", sessionStatus: "running",
    turnStatus: "in_progress", rootStatus: "running", rootInterruptRequestedAt: null, taskStatus: "queued",
    taskAttemptCount: 0, taskMaxAttempts: 3, taskStartedAt: null, taskLeaseOwner: null, taskLeaseExpiresAt: null,
    taskInterruptRequestedAt: null, taskNextAttemptAt: null, childWaitResumable: false,
  }
}

type FakeOptions = {
  rows?: Array<Record<string, unknown>>
  session?: Record<string, unknown>
  turnExists?: boolean
  currentTurnRootTaskId?: string
  admitted?: boolean
  root?: Record<string, unknown>
  task?: Record<string, unknown>
  dispatch?: Record<string, unknown>
  updateCount?: number
  failQuery?: (sql: string) => Error | undefined
}

function fakePool(options: FakeOptions = {}) {
  const rows = options.rows ?? [snapshotRow()]
  const events: Array<{ sql: string; params?: unknown[]; client: number }> = []
  const clients: Array<{ inTransaction: boolean; released: boolean }> = []
  const currentSnapshot = rows[0] ?? snapshotRow()
  const dispatch = { ...currentSnapshot, ...(options.dispatch ?? {}) }
  const pool = {
    connect: vi.fn(async () => {
      const index = clients.length, state = { inTransaction: false, released: false }
      clients.push(state)
      return {
        async query(sql: string, params?: unknown[]) {
          events.push({ sql, params, client: index })
          const failure = options.failQuery?.(sql)
          if (failure) throw failure
          if (sql === "BEGIN") { state.inTransaction = true; return { rows: [], rowCount: 0 } }
          if (sql === "COMMIT" || sql === "ROLLBACK") { state.inTransaction = false; return { rows: [], rowCount: 0 } }
          if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('LIMIT $4')) return { rows, rowCount: rows.length }
          if (sql.includes('FROM "agent_sessions" AS session') && sql.includes("FOR UPDATE")) {
            return { rows: [options.session ?? { id: payload.sessionId, userId: "user-1", status: "running" }], rowCount: 1 }
          }
          if (sql.includes('FROM "agent_turns" AS turn')) {
            const turnRootTaskId = options.currentTurnRootTaskId ?? payload.rootTaskId
            const requestedRootTaskId = params?.[4]
            const matchesRoot = !sql.includes("FOR UPDATE") || requestedRootTaskId === turnRootTaskId
            const rows = options.turnExists === false || !matchesRoot ? [] : [{ id: "turn-1", status: "in_progress", rootTaskId: turnRootTaskId }]
            return { rows, rowCount: rows.length }
          }
          if (sql.includes("pause_request")) return { rows: options.admitted === false ? [] : [{ id: payload.sessionId }], rowCount: options.admitted === false ? 0 : 1 }
          if (sql.includes('FROM "sub_agent_tasks" AS root')) {
            const root = options.root ?? { id: payload.rootTaskId, status: "running", interruptRequestedAt: null }
            return { rows: root.status === "missing" ? [] : [root], rowCount: root.status === "missing" ? 0 : 1 }
          }
          if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE")) {
            const task = options.task ?? { id: payload.taskId, sessionId: payload.sessionId, turnId: "turn-1", rootTaskId: payload.rootTaskId,
              status: "queued", attemptCount: 0, maxAttempts: 3, startedAt: null, leaseOwner: null, leaseExpiresAt: null,
              interruptRequestedAt: null, nextAttemptAt: null, childWaitResumable: false }
            return { rows: task.status === "missing" ? [] : [task], rowCount: task.status === "missing" ? 0 : 1 }
          }
          if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE")) return { rows: [dispatch], rowCount: 1 }
          if (sql.startsWith('UPDATE "agent_outbox"')) return { rows: [], rowCount: options.updateCount ?? 1 }
          return { rows: [], rowCount: 0 }
        },
        release() { state.released = true },
      }
    }),
  }
  return { pool: pool as unknown as PgSubagentPool, events, clients, connect: pool.connect }
}

describe("recoverMissingPublishedSubagentDispatches", () => {
  it("probes only after the snapshot client is released and clears only the unchanged publication", async () => {
    const fake = fakePool()
    const getJob = vi.fn(async (id: string) => {
      expect(id).toBe(subagentDispatchJobId(payload.taskId, 1))
      expect(fake.clients).toHaveLength(1)
      expect(fake.clients[0]?.inTransaction).toBe(false)
      expect(fake.clients[0]?.released).toBe(true)
      return undefined
    })

    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(1)
    expect(getJob).toHaveBeenCalledTimes(1)
    expect(fake.clients).toHaveLength(2)
    expect(fake.events.map(event => event.sql).filter(sql => sql === "COMMIT")).toHaveLength(2)
    const snapshotSql = fake.events.find(event => event.sql.includes('LIMIT $4'))?.sql ?? ""
    expect(snapshotSql).toContain('turn."rootTaskId" AS "turnRootTaskId"')
    expect(snapshotSql).toContain('turn."rootTaskId" = task."rootTaskId"')
    expect(snapshotSql).toContain('wait."status" IN (\'ready\', \'timed_out\') AND wait."suspendedAt" IS NOT NULL')
    expect(snapshotSql).toContain('wait."consumedAt" IS NULL AND step."status" = \'waiting_for_tool\'')
    expect(snapshotSql).toContain('continuation."ordinal" = step."ordinal" + 1')
    const statements = fake.events.filter(event => event.client === 1).map(event => event.sql)
    expect(statements.findIndex(sql => sql.includes('FROM "agent_sessions" AS session') && sql.includes("FOR UPDATE")))
      .toBeLessThan(statements.findIndex(sql => sql.includes('FROM "agent_turns" AS turn')))
    expect(statements.findIndex(sql => sql.includes('FROM "agent_turns" AS turn')))
      .toBeLessThan(statements.findIndex(sql => sql.includes('FROM "sub_agent_tasks" AS root')))
    expect(statements.findIndex(sql => sql.includes('FROM "sub_agent_tasks" AS root')))
      .toBeLessThan(statements.findIndex(sql => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE")))
    expect(statements.findIndex(sql => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE")))
      .toBeLessThan(statements.findIndex(sql => sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE")))
    const lockedTurn = statements.find(sql => sql.includes('FROM "agent_turns" AS turn') && sql.includes("FOR UPDATE")) ?? ""
    expect(lockedTurn).toContain('turn."rootTaskId" = $5')
    const update = statements.find(sql => sql.startsWith('UPDATE "agent_outbox"'))
    expect(update).toContain('SET "publishedAt" = NULL')
    expect(update).not.toMatch(/SET[^\n]*(?:payload|attemptCount|lastError)/)
    expect(fake.clients.every(client => client.released && !client.inTransaction)).toBe(true)
  })

  it.each([{}, "waiting", { state: "completed" }, 0, false] as const)("does not clear when Bull returns an existing job (%s)", async existing => {
    const fake = fakePool()
    const getJob = vi.fn(async () => existing)
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(getJob).toHaveBeenCalledTimes(1)
    expect(fake.connect).toHaveBeenCalledTimes(1)
    expect(fake.clients[0]).toMatchObject({ inTransaction: false, released: true })
  })

  it("keeps an active canonical job in place while it may still claim", async () => {
    const fake = fakePool()
    const getState = vi.fn(async () => "active")
    const getJob = vi.fn(async () => ({ id: subagentDispatchJobId(payload.taskId, 1), data: { ...payload }, getState }))
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(getState).toHaveBeenCalledTimes(1)
    expect(fake.connect).toHaveBeenCalledTimes(1)
  })

  it.each(["completed", "failed"] as const)("clears only a retained %s canonical job so a fresh generation can be published", async state => {
    const fake = fakePool()
    const expectedId = subagentDispatchJobId(payload.taskId, 1)
    const getState = vi.fn(async () => state)
    const getJob = vi.fn(async () => ({ id: expectedId, data: { ...payload }, getState }))
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(1)
    expect(getJob).toHaveBeenCalledWith(expectedId)
    expect(getState).toHaveBeenCalledTimes(1)
    const update = fake.events.find(event => event.sql.startsWith('UPDATE "agent_outbox"'))
    expect(update?.sql).toContain('SET "publishedAt" = NULL')
    expect(update?.sql).toContain('"attemptCount" = $5')
    expect(update?.sql).toContain('"payload" = $7::jsonb')
    expect(update?.sql).not.toMatch(/SET[^\n]*(?:payload|attemptCount|lastError)/)
    expect(fake.clients.every(client => client.released && !client.inTransaction)).toBe(true)
  })

  it("keeps a retained job when its state cannot be read safely", async () => {
    const fake = fakePool()
    const getJob = vi.fn(async () => ({ id: subagentDispatchJobId(payload.taskId, 1), data: { ...payload },
      getState: async () => { throw new Error("redis unavailable") } }))
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(fake.connect).toHaveBeenCalledTimes(1)
  })

  it("does not clear a terminal job whose payload is from a different dispatch owner", async () => {
    const fake = fakePool()
    const getState = vi.fn(async () => "completed")
    const getJob = vi.fn(async () => ({ id: subagentDispatchJobId(payload.taskId, 1),
      data: { ...payload, ownerId: "stale-owner" }, getState }))
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(getState).not.toHaveBeenCalled()
    expect(fake.connect).toHaveBeenCalledTimes(1)
  })

  it("skips a missing getJob capability and an uncertain Redis probe", async () => {
    const unsupported = fakePool()
    await expect(recoverMissingPublishedSubagentDispatches(unsupported.pool, {})).resolves.toBe(0)
    expect(unsupported.connect).not.toHaveBeenCalled()
    const uncertain = fakePool()
    await expect(recoverMissingPublishedSubagentDispatches(uncertain.pool, { getJob: async () => { throw new Error("redis unavailable") } })).resolves.toBe(0)
    expect(uncertain.clients).toHaveLength(1)
    expect(uncertain.clients[0]).toMatchObject({ inTransaction: false, released: true })
  })

  it("caps oversized snapshot rows and the requested batch before probing", async () => {
    const rows = Array.from({ length: 55 }, (_, index) => snapshotRow(`task-${index}`))
    const fake = fakePool({ rows })
    const getJob = vi.fn(async () => ({ id: "still-present" }))
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob }, 500)).resolves.toBe(0)
    expect(getJob).toHaveBeenCalledTimes(50)
    expect(fake.events.find(event => event.sql.includes('LIMIT $4'))?.params?.[3]).toBe(50)
    expect(fake.connect).toHaveBeenCalledTimes(1)
  })

  it("ignores malformed, too-new, task-started, and exhausted-generation snapshot rows", async () => {
    const invalid = [
      { ...snapshotRow("bad-payload"), payload: { ...payload, unexpected: true } },
      { ...snapshotRow("young"), publishedAt: new Date(), publishedAtText: new Date().toISOString() },
      { ...snapshotRow("started"), taskStartedAt: new Date() },
      { ...snapshotRow("unsafe-generation"), attemptCount: 2_147_483_647 },
      { ...snapshotRow("missing-turn-status"), turnStatus: undefined },
      { ...snapshotRow("empty-root-status"), rootStatus: "" },
      { ...snapshotRow("mismatched-publish-time"), publishedAtText: new Date().toISOString() },
    ]
    const valid = snapshotRow("valid")
    const fake = fakePool({ rows: [...invalid, valid] })
    const getJob = vi.fn(async () => ({ id: "present" }))
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(getJob).toHaveBeenCalledTimes(1)
    expect(getJob).toHaveBeenCalledWith(subagentDispatchJobId("valid", 1))
  })

  it("revalidates the exact owner and publication before changing anything", async () => {
    const changed = fakePool({ dispatch: { payload: { ...payload, ownerId: "rotated-owner" } } })
    await expect(recoverMissingPublishedSubagentDispatches(changed.pool, { getJob: async () => null })).resolves.toBe(0)
    expect(changed.events.some(event => event.sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
    expect(changed.events.some(event => event.sql === "ROLLBACK")).toBe(true)
    expect(changed.clients.every(client => client.released && !client.inTransaction)).toBe(true)

    const stale = fakePool({ admitted: false })
    await expect(recoverMissingPublishedSubagentDispatches(stale.pool, { getJob: async () => null })).resolves.toBe(0)
    expect(stale.events.some(event => event.sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
  })

  it("rejects a snapshot whose Turn belongs to a different Root before probing Bull", async () => {
    const fake = fakePool({ rows: [{ ...snapshotRow(), turnRootTaskId: "other-root" }] })
    const getJob = vi.fn(async () => undefined)
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(getJob).not.toHaveBeenCalled()
    expect(fake.events.some(event => event.sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
  })

  it("recovers a published child-wait continuation at the exhausted task attempt using the separate outbox generation", async () => {
    const continuation = { ...snapshotRow(), attemptCount: 9, taskAttemptCount: 3, taskMaxAttempts: 3,
      taskStartedAt: new Date(Date.now() - 180_000), childWaitResumable: true }
    const fake = fakePool({ rows: [continuation], task: { id: payload.taskId, sessionId: payload.sessionId, turnId: "turn-1",
      rootTaskId: payload.rootTaskId, status: "queued", attemptCount: 3, maxAttempts: 3,
      startedAt: continuation.taskStartedAt, leaseOwner: null, leaseExpiresAt: null,
      interruptRequestedAt: null, nextAttemptAt: null, childWaitResumable: true } })
    const getJob = vi.fn(async (id: string) => {
      expect(id).toBe(subagentDispatchJobId(payload.taskId, 8))
      return undefined
    })

    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(1)
    const snapshotSql = fake.events.find(event => event.sql.includes('LIMIT $4'))?.sql ?? ""
    const currentTaskSql = fake.events.find(event => event.sql.includes('FROM "sub_agent_tasks" AS task') && event.sql.includes("FOR UPDATE"))?.sql ?? ""
    expect(snapshotSql).toContain('OR (SELECT COUNT(*) = 1')
    expect(snapshotSql).toContain('task."status" = \'queued\'')
    expect(currentTaskSql).toContain('AS "childWaitResumable"')
    expect(fake.events.some(event => event.sql.startsWith('UPDATE "agent_outbox"'))).toBe(true)
  })

  it("does not treat an exhausted started task as a continuation without the exact current wait", async () => {
    const stale = { ...snapshotRow(), attemptCount: 9, taskAttemptCount: 3, taskMaxAttempts: 3,
      taskStartedAt: new Date(Date.now() - 180_000), childWaitResumable: false }
    const fake = fakePool({ rows: [stale] })
    const getJob = vi.fn(async () => undefined)
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(getJob).not.toHaveBeenCalled()
  })

  it("rechecks that the task attempt stayed current while the queue absence was probed", async () => {
    const continuation = { ...snapshotRow(), attemptCount: 9, taskAttemptCount: 3, taskMaxAttempts: 3,
      taskStartedAt: new Date(Date.now() - 180_000), childWaitResumable: true }
    const fake = fakePool({ rows: [continuation], task: { id: payload.taskId, sessionId: payload.sessionId, turnId: "turn-1",
      rootTaskId: payload.rootTaskId, status: "queued", attemptCount: 4, maxAttempts: 3,
      startedAt: continuation.taskStartedAt, leaseOwner: null, leaseExpiresAt: null,
      interruptRequestedAt: null, nextAttemptAt: null, childWaitResumable: true } })
    const getJob = vi.fn(async () => undefined)
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(getJob).toHaveBeenCalledTimes(1)
    expect(fake.events.some(event => event.sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
  })

  it("does not clear publication when the current Turn Root changes after the Redis probe", async () => {
    const fake = fakePool({ currentTurnRootTaskId: "other-root" })
    const getJob = vi.fn(async () => undefined)
    await expect(recoverMissingPublishedSubagentDispatches(fake.pool, { getJob })).resolves.toBe(0)
    expect(getJob).toHaveBeenCalledTimes(1)
    expect(fake.events.some(event => event.sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
    expect(fake.events.some(event => event.sql === "ROLLBACK")).toBe(true)
    expect(fake.clients.every(client => client.released && !client.inTransaction)).toBe(true)
  })

  it("propagates PostgreSQL failures and counts only a successful conditional update", async () => {
    const snapshotFailure = fakePool({ failQuery: sql => sql.includes('LIMIT $4') ? new Error("database unavailable") : undefined })
    await expect(recoverMissingPublishedSubagentDispatches(snapshotFailure.pool, { getJob: async () => null })).rejects.toThrow("database unavailable")
    const lostUpdate = fakePool({ updateCount: 0 })
    await expect(recoverMissingPublishedSubagentDispatches(lostUpdate.pool, { getJob: async () => null })).resolves.toBe(0)
    expect(lostUpdate.clients.every(client => client.released && !client.inTransaction)).toBe(true)
  })
})
