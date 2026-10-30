import { beforeEach, describe, expect, it, vi } from "vitest"

const graphMocks = vi.hoisted(() => ({ prepare: vi.fn(), persist: vi.fn() }))
vi.mock("./task-graph-pg-lifecycle.js", () => ({
  prepareGraphTransition: graphMocks.prepare,
  persistGraphTransition: graphMocks.persist,
}))

import { handoffDurableSubagentWait, handoffDurableSubagentWaitWithGraph, recoverExpiredDurableSubagentWaitWithGraph, releaseDurableSubagentWaitWithGraph } from "./durable-subagent-wait-handoff.js"

const now = new Date("2026-10-22T10:00:00.000Z")
const lease = {
  id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  ownerId: "worker-1", attemptCount: 3, leaseExpiresAt: new Date(now.getTime() + 60_000),
}

function fixture(options: { wait?: boolean; waitStatus?: string; stepStatus?: string; targetStatus?: string; taskStatus?: string; suspended?: boolean; expireAtTaskUpdate?: boolean; callMatches?: boolean; targetId?: string; waitTargetTaskIds?: unknown } = {}) {
  const targetId = options.targetId ?? "child-1"
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
      if (sql.includes('SELECT task."turnId", task."rootTaskId", task."leaseExpiresAt"')) return options.wait === false ? { rows: [], rowCount: 0 } : { rows: [{ turnId: "turn-1", rootTaskId: "root-1", leaseExpiresAt: lease.leaseExpiresAt, stepStatus: options.stepStatus ?? "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && !sql.includes("ANY($1::text[])")) return { rows: [{
        id: "parent-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", status: state.taskStatus,
        attemptCount: 3, leaseOwner: state.taskStatus === "running" ? "worker-1" : null,
        leaseExpiresAt: state.taskStatus === "running" ? lease.leaseExpiresAt : null, interruptRequestedAt: null,
        userId: "user-1", turnStatus: "in_progress", rootStatus: "running",
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions" AS wait')) return options.wait === false ? { rows: [], rowCount: 0 } : { rows: [{
        id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1", stepId: "step-1", idempotencyKey: "wait-key-1",
        targetTaskIds: options.waitTargetTaskIds ?? [targetId], mode: "any", status: state.waitStatus, deadlineAt: new Date(now.getTime() + 10_000),
        matchedTaskIds: [], result: { request: { targetTaskIds: [targetId], mode: "any", timeoutMs: 10_000 }, note: "Call +353 87 123 4567 or email private@example.test." }, suspendedAt: options.suspended ? now : null, consumedAt: null, attempt: 3, ordinal: 4, latestOrdinal: 4,
        stepStatus: options.stepStatus ?? "waiting_for_tool",
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_items" AS call')) return { rows: [{ status: "started", content: {
        toolCallId: "wait-call-1", toolName: "wait_subagents", toolVersion: "1",
        input: { idempotencyKey: options.callMatches === false ? "wrong-key" : "wait-key-1", mode: "any", taskIds: [targetId], timeoutMs: 10_000 },
      } }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("ANY($1::text[])")) return { rows: [{
        id: targetId, parentTaskId: "parent-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1",
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

  it("preserves the exact live lease when release meets a streaming wait", async () => {
    const fake = fixture({ stepStatus: "streaming" })
    await expect(releaseDurableSubagentWaitWithGraph(fake.client as never, {
      id: lease.id, userId: lease.userId, sessionId: lease.sessionId, ownerId: lease.ownerId, attemptCount: lease.attemptCount, now,
    })).resolves.toBe(false)
    expect(fake.state).toMatchObject({ waitWrites: 0, taskWrites: 0, outboxWrites: 0 })
    expect(graphMocks.prepare).not.toHaveBeenCalled()
  })

  it("uses the graph-aware durable handoff for a completed tool step", async () => {
    const fake = fixture({ targetStatus: "completed" })
    await expect(releaseDurableSubagentWaitWithGraph(fake.client as never, {
      id: lease.id, userId: lease.userId, sessionId: lease.sessionId, ownerId: lease.ownerId, attemptCount: lease.attemptCount, now,
    })).resolves.toBe(true)
    expect(fake.state).toMatchObject({ waitStatus: "ready", taskStatus: "queued", waitWrites: 1, taskWrites: 1, outboxWrites: 1 })
  })

  it("leaves the generic release path available when no durable wait is registered", async () => {
    const fake = fixture({ wait: false })
    await expect(releaseDurableSubagentWaitWithGraph(fake.client as never, {
      id: lease.id, userId: lease.userId, sessionId: lease.sessionId, ownerId: lease.ownerId, attemptCount: lease.attemptCount, now,
    })).resolves.toBeUndefined()
    expect(fake.state).toMatchObject({ waitWrites: 0, taskWrites: 0, outboxWrites: 0 })
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

  it("preserves only the validated target ID through ordinary handoff sanitization", async () => {
    const targetId = "subagent-00000000-0000-4000-8000-000000000000"
    const fake = fixture({ targetId, targetStatus: "completed" })
    await handoffDurableSubagentWait(fake.client as never, { lease, now })
    const update = fake.calls.find(call => call.sql.includes('UPDATE "agent_wait_conditions"'))
    const saved = JSON.parse(String(update?.params[2])) as { request: { targetTaskIds: string[] }; note: string }
    expect(saved.request.targetTaskIds).toEqual([targetId])
    expect(saved.note).toContain("[REDACTED_PHONE]")
    expect(saved.note).toContain("[REDACTED_EMAIL]")
    expect(saved.note).not.toContain("+353 87 123 4567")
    expect(saved.note).not.toContain("private@example.test")
  })

  it("throws when a matching persisted wait points at a stale step", async () => {
    const fake = fixture({ stepStatus: "completed" })
    await expect(handoffDurableSubagentWait(fake.client as never, { lease, now })).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state.waitWrites).toBe(0)
    expect(fake.state.taskWrites).toBe(0)
    expect(fake.state.outboxWrites).toBe(0)
  })

  it("rejects mixed-type registered target IDs before normal handoff writes", async () => {
    const fake = fixture({ waitTargetTaskIds: ["child-1", 17], targetStatus: "completed" })
    await expect(handoffDurableSubagentWait(fake.client as never, { lease, now })).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state).toMatchObject({ waitWrites: 0, taskWrites: 0, outboxWrites: 0 })
    expect(fake.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("promotes the exact latest streaming step before recovering its committed wait", async () => {
    const fake = fixture({ stepStatus: "streaming" })
    const expiredLease = { ...lease, leaseExpiresAt: new Date(now.getTime() - 1) }
    await expect(recoverExpiredDurableSubagentWaitWithGraph(fake.client as never, { lease: expiredLease, now }))
      .resolves.toMatchObject({ waitId: "wait-1", handoff: "suspended", waitStatus: "waiting" })
    const promote = fake.calls.find(call => call.sql.includes('UPDATE "agent_steps"'))
    expect(promote?.sql).toContain('"status" = \'streaming\'')
    expect(promote?.sql).toContain('"attempt" = $6')
    expect(promote?.sql).toContain('"leaseOwner" = $9')
    expect(promote?.sql).toContain('"leaseExpiresAt" = $10')
    expect(promote?.params).toEqual([now, "step-1", lease.sessionId, lease.turnId, lease.id, lease.attemptCount, 4, lease.rootTaskId, lease.ownerId, expiredLease.leaseExpiresAt])
  })

  it("preserves only the validated target ID through expired-wait recovery sanitization", async () => {
    const targetId = "subagent-00000000-0000-4000-8000-000000000000"
    const fake = fixture({ targetId, stepStatus: "streaming" })
    const expiredLease = { ...lease, leaseExpiresAt: new Date(now.getTime() - 1) }
    await recoverExpiredDurableSubagentWaitWithGraph(fake.client as never, { lease: expiredLease, now })
    const update = fake.calls.find(call => call.sql.includes('UPDATE "agent_wait_conditions"'))
    const saved = JSON.parse(String(update?.params[2])) as { request: { targetTaskIds: string[] }; note: string }
    expect(saved.request.targetTaskIds).toEqual([targetId])
    expect(saved.note).toContain("[REDACTED_PHONE]")
    expect(saved.note).toContain("[REDACTED_EMAIL]")
    expect(saved.note).not.toContain("+353 87 123 4567")
    expect(saved.note).not.toContain("private@example.test")
  })

  it("rejects recovery when the persisted wait call does not identify the exact registered request", async () => {
    const fake = fixture({ callMatches: false })
    await expect(handoffDurableSubagentWait(fake.client as never, { lease, now })).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state).toMatchObject({ waitWrites: 0, taskWrites: 0, outboxWrites: 0 })
  })

  it("does not recover an expired wait when its persisted call is outside the registered scope", async () => {
    const fake = fixture({ callMatches: false, stepStatus: "streaming" })
    const expiredLease = { ...lease, leaseExpiresAt: new Date(now.getTime() - 1) }
    await expect(recoverExpiredDurableSubagentWaitWithGraph(fake.client as never, { lease: expiredLease, now })).resolves.toBeUndefined()
    expect(fake.state).toMatchObject({ waitWrites: 0, taskWrites: 0, outboxWrites: 0 })
    expect(fake.calls.some(call => call.sql.includes('UPDATE "agent_steps"'))).toBe(false)
  })

  it("rejects mixed-type expired target IDs before step promotion or handoff writes", async () => {
    const fake = fixture({ waitTargetTaskIds: ["child-1", 17], stepStatus: "streaming" })
    const expiredLease = { ...lease, leaseExpiresAt: new Date(now.getTime() - 1) }
    await expect(recoverExpiredDurableSubagentWaitWithGraph(fake.client as never, { lease: expiredLease, now }))
      .rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state).toMatchObject({ waitWrites: 0, taskWrites: 0, outboxWrites: 0 })
    expect(fake.calls.some(call => call.sql.includes('UPDATE "agent_steps"'))).toBe(false)
    expect(fake.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
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
