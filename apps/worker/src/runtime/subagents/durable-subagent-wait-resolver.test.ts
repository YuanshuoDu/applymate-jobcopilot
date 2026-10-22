import { beforeEach, describe, expect, it, vi } from "vitest"

const graphMocks = vi.hoisted(() => ({ prepare: vi.fn(), persist: vi.fn() }))
vi.mock("./task-graph-pg-lifecycle.js", () => ({
  prepareGraphTransition: graphMocks.prepare,
  persistGraphTransition: graphMocks.persist,
}))

import { reconcileDurableSubagentWaits } from "./durable-subagent-wait-resolver.js"

const now = new Date("2026-10-22T10:00:00.000Z")

type DispatchFixture = { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: Record<string, unknown>; attemptCount: number; publishedAt: Date | null }

function fixture(input: { targetStatus?: string; deadline?: Date; targetParent?: string; batchSize?: number; dispatchRow?: DispatchFixture | null } = {}) {
  const calls: { sql: string; params: unknown[] }[] = []
  const state = { waitStatus: "waiting", parentStatus: "waiting", matched: [] as string[], outbox: input.dispatchRow ? 1 : 0,
    dispatchRow: input.dispatchRow ? structuredClone(input.dispatchRow) : null as DispatchFixture | null }
  let rollbackSnapshot: typeof state | undefined
  const cloneState = () => ({ ...state, matched: [...state.matched], dispatchRow: state.dispatchRow ? structuredClone(state.dispatchRow) : null })
  const wait = {
    id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1", rootTaskId: "root-1", parentAttempt: 3,
    targetTaskIds: ["child-1", "child-2"], mode: "all", status: state.waitStatus, deadlineAt: input.deadline ?? new Date(now.getTime() + 30_000),
    matchedTaskIds: [], result: { request: { targetTaskIds: ["child-1", "child-2"], mode: "all", timeoutMs: 30_000 } },
  }
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (sql === "BEGIN") { rollbackSnapshot = cloneState(); return { rows: [], rowCount: 1 } }
      if (sql === "ROLLBACK") { if (rollbackSnapshot) Object.assign(state, rollbackSnapshot); rollbackSnapshot = undefined; return { rows: [], rowCount: 1 } }
      if (sql === "COMMIT") { rollbackSnapshot = undefined; return { rows: [], rowCount: 1 } }
      if (sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT session."id", session."userId"') && sql.includes('JOIN "sub_agent_tasks" AS parent')) {
        return { rows: [{ id: "session-1", userId: "user-1" }], rowCount: 1 }
      }
      if (sql.includes('SELECT wait."id", wait."userId"') && sql.includes('FOR UPDATE OF wait, parent')) return { rows: [wait], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("ANY($1::text[])")) return { rows: [
        { id: "child-1", parentTaskId: input.targetParent ?? "parent-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", status: "completed", role: "writer", result: { title: "safe" }, failureReason: null },
        { id: "child-2", parentTaskId: "parent-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", status: input.targetStatus ?? "completed", role: "reviewer", result: { score: 1 }, failureReason: null },
      ], rowCount: 2 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) { state.waitStatus = String(params[0]); state.matched = JSON.parse(String(params[1])); return { rows: [], rowCount: 1 } }
      if (sql.includes('UPDATE "sub_agent_tasks"')) { state.parentStatus = "queued"; return { rows: [], rowCount: 1 } }
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('WHERE dispatch."idempotencyKey" = $1')) {
        return { rows: state.dispatchRow ? [structuredClone(state.dispatchRow)] : [], rowCount: state.dispatchRow ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_outbox" AS dispatch')) {
        const [payload, id, topic, aggregateId, idempotencyKey, attemptCount, taskId, sessionId, rootTaskId, ownerId] = params
        const row = state.dispatchRow
        if (!row || row.id !== id || row.topic !== topic || row.aggregateId !== aggregateId || row.idempotencyKey !== idempotencyKey
          || row.attemptCount !== attemptCount || row.payload.taskId !== taskId || row.payload.sessionId !== sessionId
          || row.payload.rootTaskId !== rootTaskId || row.payload.ownerId !== ownerId) return { rows: [], rowCount: 0 }
        row.payload = JSON.parse(String(payload)); row.attemptCount += 1
        return { rows: [{ attemptCount: row.attemptCount }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) { state.outbox += 1; return { rows: [{ attemptCount: 2 }], rowCount: 1 } }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { pool: { connect: async () => client }, calls, state }
}

describe("reconcileDurableSubagentWaits", () => {
  beforeEach(() => {
    graphMocks.prepare.mockReset().mockResolvedValue(null)
    graphMocks.persist.mockReset().mockResolvedValue(undefined)
  })

  it("locks sessions before waits, resolves an all-condition, and queues the same parent attempt", async () => {
    const fake = fixture()
    await expect(reconcileDurableSubagentWaits(fake.pool as never, { now, batchSize: 4, ownerId: "recover-1" })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(fake.state).toMatchObject({ waitStatus: "ready", parentStatus: "queued", matched: ["child-1", "child-2"], outbox: 1 })
    const sessionLock = fake.calls.findIndex(call => call.sql.includes('SELECT session."id", session."userId"'))
    const waitLock = fake.calls.findIndex(call => call.sql.includes('FOR UPDATE OF wait, parent'))
    const targetRead = fake.calls.findIndex(call => call.sql.includes('ANY($1::text[])'))
    const waitUpdate = fake.calls.findIndex(call => call.sql.includes('UPDATE "agent_wait_conditions"'))
    const parentUpdate = fake.calls.find(call => call.sql.includes('UPDATE "sub_agent_tasks"'))
    const dispatch = fake.calls.find(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(sessionLock).toBeGreaterThanOrEqual(0)
    expect(waitLock).toBeGreaterThan(sessionLock)
    expect(targetRead).toBeGreaterThan(waitLock)
    expect(waitUpdate).toBeGreaterThan(targetRead)
    expect(parentUpdate?.sql).not.toContain('SET "attemptCount"')
    expect(parentUpdate?.sql).toContain('"status" = \'waiting\'')
    expect(dispatch?.params[2]).toBe("subagent-dispatch:parent-1")
    expect(dispatch?.sql).toContain("ON CONFLICT (\"idempotencyKey\") DO UPDATE")
    expect(dispatch?.sql).not.toContain('"attemptCount"')
  })

  it("leaves a nonterminal any/all wait parked until a child or timeout resolves it", async () => {
    const fake = fixture({ targetStatus: "running" })
    await expect(reconcileDurableSubagentWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 0, woken: 0 })
    expect(fake.state.waitStatus).toBe("waiting")
    expect(fake.state.parentStatus).toBe("waiting")
    expect(fake.state.outbox).toBe(0)
  })

  it("times out exactly once and fails closed when a target is no longer a direct child", async () => {
    const timedOut = fixture({ targetStatus: "running", deadline: new Date(now.getTime() - 1) })
    await expect(reconcileDurableSubagentWaits(timedOut.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(timedOut.state).toMatchObject({ waitStatus: "timed_out", matched: ["child-1"], parentStatus: "queued", outbox: 1 })

    const outOfScope = fixture({ targetParent: "other-parent" })
    await expect(reconcileDurableSubagentWaits(outOfScope.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 0, woken: 0 })
    expect(outOfScope.state.waitStatus).toBe("waiting")
    expect(outOfScope.state.outbox).toBe(0)
  })

  it("persists the queued TaskGraph event with the durable dispatch", async () => {
    const transition = { event: { type: "task.queued" } }
    graphMocks.prepare.mockResolvedValueOnce(transition)
    const fake = fixture()
    await expect(reconcileDurableSubagentWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 1 })
    expect(graphMocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId: "parent-1", sessionId: "session-1", type: "task.queued", attemptCount: 3,
    }))
    expect(graphMocks.persist).toHaveBeenCalledWith(expect.anything(), transition, now)
    expect(fake.state).toMatchObject({ waitStatus: "ready", parentStatus: "queued", outbox: 1 })
  })

  it("resolves a wait but leaves its graph-blocked parent parked without dispatch", async () => {
    graphMocks.prepare.mockResolvedValueOnce({ blocked: true })
    const fake = fixture()
    await expect(reconcileDurableSubagentWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 0 })
    expect(fake.state).toMatchObject({ waitStatus: "ready", parentStatus: "waiting", outbox: 0 })
  })

  it.each([
    ["published", new Date("2026-10-22T09:59:00.000Z")],
    ["pending", null],
  ] as const)("rotates the owner and generation of an existing %s dispatch while graph-blocked", async (_label, publishedAt) => {
    graphMocks.prepare.mockResolvedValueOnce({ blocked: true })
    const fake = fixture({ dispatchRow: {
      id: "dispatch-1", topic: "agent.subagent.dispatch", aggregateId: "session-1", idempotencyKey: "subagent-dispatch:parent-1",
      payload: { taskId: "parent-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "stale-owner" }, attemptCount: 4, publishedAt,
    } })

    await expect(reconcileDurableSubagentWaits(fake.pool as never, { now })).resolves.toEqual({ scanned: 1, resolved: 1, woken: 0 })

    expect(fake.state).toMatchObject({ waitStatus: "ready", parentStatus: "waiting", outbox: 1 })
    expect(fake.state.dispatchRow).toMatchObject({ attemptCount: 5, publishedAt })
    expect(fake.state.dispatchRow?.payload).toMatchObject({ taskId: "parent-1", sessionId: "session-1", rootTaskId: "root-1" })
    expect(fake.state.dispatchRow?.payload.ownerId).not.toBe("stale-owner")
    expect(fake.calls.some(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(graphMocks.persist).not.toHaveBeenCalled()
  })

  it("fails closed and rolls back a malformed matching dispatch row", async () => {
    graphMocks.prepare.mockResolvedValueOnce({ blocked: true })
    const fake = fixture({ dispatchRow: {
      id: "dispatch-1", topic: "agent.subagent.dispatch", aggregateId: "session-1", idempotencyKey: "subagent-dispatch:parent-1",
      payload: { taskId: "other-task", sessionId: "session-1", rootTaskId: "root-1", ownerId: "stale-owner" }, attemptCount: 4, publishedAt: null,
    } })

    await expect(reconcileDurableSubagentWaits(fake.pool as never, { now })).rejects.toMatchObject({ code: "wait_scope_error" })

    expect(fake.state).toMatchObject({ waitStatus: "waiting", parentStatus: "waiting", outbox: 1 })
    expect(fake.state.dispatchRow?.payload.taskId).toBe("other-task")
    expect(fake.calls.some(call => call.sql.includes('UPDATE "agent_outbox" AS dispatch'))).toBe(false)
  })

  it("bounds scan work before opening a transaction", async () => {
    const fake = fixture()
    await expect(reconcileDurableSubagentWaits(fake.pool as never, { batchSize: 101 })).rejects.toThrow("batch size")
    expect(fake.calls).toHaveLength(0)
  })
})
