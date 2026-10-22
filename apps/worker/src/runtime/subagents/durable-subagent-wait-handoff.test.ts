import { beforeEach, describe, expect, it, vi } from "vitest"

const graphMocks = vi.hoisted(() => ({ prepare: vi.fn(), persist: vi.fn() }))
vi.mock("./task-graph-pg-lifecycle.js", () => ({
  prepareGraphTransition: graphMocks.prepare,
  persistGraphTransition: graphMocks.persist,
}))

import { handoffDurableSubagentWait, handoffDurableSubagentWaitWithGraph } from "./durable-subagent-wait-handoff.js"

const now = new Date("2026-10-22T10:00:00.000Z")
const lease = {
  id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  ownerId: "worker-1", attemptCount: 3, leaseExpiresAt: new Date(now.getTime() + 60_000),
}

function fixture(options: { wait?: boolean; waitStatus?: string; stepStatus?: string; targetStatus?: string; taskStatus?: string; suspended?: boolean; expireAtTaskUpdate?: boolean; callMatches?: boolean } = {}) {
  const calls: { sql: string; params: unknown[] }[] = []
  const state = { taskStatus: options.taskStatus ?? "running", waitStatus: options.waitStatus ?? "waiting", outboxWrites: 0, waitWrites: 0, taskWrites: 0, taskUpdateAttempts: 0 }
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        if (sql === "ROLLBACK") state.waitStatus = "waiting"
        return { rows: [], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id", "userId", "status" FROM "agent_sessions"')) return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && !sql.includes("ANY($1::text[])")) return { rows: [{
        id: "parent-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", status: state.taskStatus,
        attemptCount: 3, leaseOwner: state.taskStatus === "running" ? "worker-1" : null,
        leaseExpiresAt: state.taskStatus === "running" ? lease.leaseExpiresAt : null, interruptRequestedAt: null,
        userId: "user-1", turnStatus: "in_progress", rootStatus: "running",
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions" AS wait')) return options.wait === false ? { rows: [], rowCount: 0 } : { rows: [{
        id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1", stepId: "step-1", idempotencyKey: "wait-key-1",
        targetTaskIds: ["child-1"], mode: "any", status: state.waitStatus, deadlineAt: new Date(now.getTime() + 10_000),
        matchedTaskIds: [], result: { request: { targetTaskIds: ["child-1"], mode: "any", timeoutMs: 10_000 } }, suspendedAt: options.suspended ? now : null, consumedAt: null, attempt: 3, ordinal: 4, latestOrdinal: 4,
        stepStatus: options.stepStatus ?? "waiting_for_tool",
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_items" AS call')) return { rows: [{ status: "started", content: {
        toolCallId: "wait-call-1", toolName: "wait_subagents", toolVersion: "1",
        input: { idempotencyKey: options.callMatches === false ? "wrong-key" : "wait-key-1", mode: "any", taskIds: ["child-1"], timeoutMs: 10_000 },
      } }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("ANY($1::text[])")) return { rows: [{
        id: "child-1", parentTaskId: "parent-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1",
        status: options.targetStatus ?? "running", role: "writer", result: { summary: "done" }, failureReason: null,
      }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) { state.waitWrites += 1; state.waitStatus = String(params[0]); return { rows: [], rowCount: 1 } }
      if (sql.includes('UPDATE "sub_agent_tasks"')) {
        state.taskUpdateAttempts += 1
        if (options.expireAtTaskUpdate) return { rows: [], rowCount: 0 }
        state.taskWrites += 1; state.taskStatus = String(params[0]); return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) { state.outboxWrites += 1; return { rows: [{ attemptCount: 1 }], rowCount: 1 } }
      return { rows: [], rowCount: 1 }
    },
  }
  return { client, calls, state }
}

describe("handoffDurableSubagentWait", () => {
  beforeEach(() => {
    graphMocks.prepare.mockReset().mockResolvedValue(null)
    graphMocks.persist.mockReset().mockResolvedValue(undefined)
  })

  it("returns undefined for a waiting child without a persisted matching wait", async () => {
    const fake = fixture({ wait: false })
    await expect(handoffDurableSubagentWait(fake.client as never, { lease, now })).resolves.toBeUndefined()
    expect(fake.state.waitWrites).toBe(0)
    expect(fake.state.taskWrites).toBe(0)
    expect(fake.state.outboxWrites).toBe(0)
  })

  it("atomically resolves, releases the same attempt, and dispatches through the queue-owned key", async () => {
    const fake = fixture({ targetStatus: "completed" })
    await expect(handoffDurableSubagentWait(fake.client as never, { lease, now })).resolves.toMatchObject({
      waitId: "wait-1", handoff: "queued", waitStatus: "ready", idempotent: false,
    })
    expect(fake.state.waitStatus).toBe("ready")
    expect(fake.state.taskStatus).toBe("queued")
    expect(fake.state.waitWrites).toBe(1)
    expect(fake.state.taskWrites).toBe(1)
    expect(fake.state.outboxWrites).toBe(1)
    const taskUpdate = fake.calls.find(call => call.sql.includes('UPDATE "sub_agent_tasks"'))
    expect(taskUpdate?.sql).toContain('"attemptCount" = $8')
    expect(taskUpdate?.params[7]).toBe(3)
    expect(taskUpdate?.sql).toContain('"leaseExpiresAt" = $9')
    expect(taskUpdate?.sql).toContain('"leaseExpiresAt" > clock_timestamp()')
    expect(taskUpdate?.params[8]).toEqual(lease.leaseExpiresAt)
    expect(taskUpdate?.sql.split("WHERE")[0]).not.toContain('"attemptCount"')
    const outbox = fake.calls.find(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(outbox?.params[2]).toBe("subagent-dispatch:parent-1")
    expect(outbox?.sql).not.toContain('"attemptCount"')
    expect(fake.calls.some(call => call.sql === "BEGIN" || call.sql === "COMMIT")).toBe(false)
  })

  it("throws when a matching persisted wait points at a stale step", async () => {
    const fake = fixture({ stepStatus: "completed" })
    await expect(handoffDurableSubagentWait(fake.client as never, { lease, now })).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state.waitWrites).toBe(0)
    expect(fake.state.taskWrites).toBe(0)
    expect(fake.state.outboxWrites).toBe(0)
  })

  it("rejects recovery when the persisted wait call does not identify the exact registered request", async () => {
    const fake = fixture({ callMatches: false })
    await expect(handoffDurableSubagentWait(fake.client as never, { lease, now })).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state).toMatchObject({ waitWrites: 0, taskWrites: 0, outboxWrites: 0 })
  })

  it("rolls back when PostgreSQL sees the lease expire after the initial check", async () => {
    const fake = fixture({ targetStatus: "completed", expireAtTaskUpdate: true })
    const runHandoffTransaction = async () => {
      await fake.client.query("BEGIN")
      try {
        await handoffDurableSubagentWait(fake.client as never, { lease, now })
        await fake.client.query("COMMIT")
      } catch (error: unknown) {
        await fake.client.query("ROLLBACK")
        throw error
      }
    }
    await expect(runHandoffTransaction()).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state).toMatchObject({ waitStatus: "waiting", taskUpdateAttempts: 1, taskWrites: 0, outboxWrites: 0 })
    expect(fake.calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(fake.calls.map(call => call.sql)).not.toContain("COMMIT")
    const taskUpdate = fake.calls.find(call => call.sql.includes('UPDATE "sub_agent_tasks"'))
    expect(taskUpdate?.sql).toContain('clock_timestamp()')
    expect(taskUpdate?.params[1]).toEqual(now)
  })

  it("replays an already suspended handoff without another task or outbox write", async () => {
    const fake = fixture({ taskStatus: "waiting", suspended: true })
    await expect(handoffDurableSubagentWait(fake.client as never, { lease, now })).resolves.toMatchObject({
      waitId: "wait-1", handoff: "suspended", waitStatus: "waiting", idempotent: true,
    })
    expect(fake.state).toMatchObject({ waitWrites: 0, taskWrites: 0, outboxWrites: 0 })
  })

  it("persists waiting and queued TaskGraph transitions with a resolved durable wait", async () => {
    const waiting = { event: { type: "task.waiting" } }
    const queued = { event: { type: "task.queued" } }
    graphMocks.prepare.mockResolvedValueOnce(waiting).mockResolvedValueOnce(queued)
    const fake = fixture({ targetStatus: "completed" })
    await expect(handoffDurableSubagentWaitWithGraph(fake.client as never, { lease, now })).resolves.toMatchObject({ handoff: "queued" })
    expect(graphMocks.prepare).toHaveBeenNthCalledWith(1, fake.client, { taskId: "parent-1", sessionId: "session-1", type: "task.waiting", attemptCount: 3 })
    expect(graphMocks.prepare).toHaveBeenNthCalledWith(2, fake.client, { taskId: "parent-1", sessionId: "session-1", type: "task.queued", attemptCount: 3 })
    expect(graphMocks.persist).toHaveBeenNthCalledWith(1, fake.client, waiting, now)
    expect(graphMocks.persist).toHaveBeenNthCalledWith(2, fake.client, queued, now)
  })

  it("distinguishes a blocked graph transition from a child with no durable wait", async () => {
    graphMocks.prepare.mockResolvedValueOnce({ blocked: true })
    const blocked = fixture()
    await expect(handoffDurableSubagentWaitWithGraph(blocked.client as never, { lease, now })).resolves.toEqual({ blocked: true })
    expect(blocked.calls).toHaveLength(0)

    const absent = fixture({ wait: false })
    graphMocks.prepare.mockResolvedValueOnce({ event: { type: "task.waiting" } })
    await expect(handoffDurableSubagentWaitWithGraph(absent.client as never, { lease, now })).resolves.toBeUndefined()
    expect(graphMocks.persist).not.toHaveBeenCalled()
  })
})
