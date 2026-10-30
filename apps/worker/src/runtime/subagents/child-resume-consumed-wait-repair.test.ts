import { beforeEach, describe, expect, it, vi } from "vitest"

const lifecycle = vi.hoisted(() => ({
  states: new Map<string, "unreconciled" | "waiting" | "recovered">(),
  inspected: [] as string[], repaired: [] as string[],
}))
vi.mock("./child-resume-source-wait-lifecycle.js", () => ({
  inspectChildWaitSourceLifecycle: vi.fn(async (_client: unknown, _lease: unknown, wait: { id: string }, _stepId: string) => {
    lifecycle.inspected.push(wait.id)
    return { state: lifecycle.states.get(wait.id) ?? "waiting", toolCallId: `call:${wait.id}`, callItemId: `item:${wait.id}`, sourceAttempt: 1 }
  }),
  reconcileChildWaitSourceLifecycle: vi.fn(async (_pool: unknown, _client: unknown, _lease: unknown, wait: { id: string }) => {
    lifecycle.repaired.push(wait.id)
    return { state: "recovered", toolCallId: `call:${wait.id}`, callItemId: `item:${wait.id}`, sourceAttempt: 1, resultItemId: `result:${wait.id}` }
  }),
}))

import { repairConsumedChildWaitSources } from "./child-resume-consumed-wait-repair.js"

const now = new Date("2026-10-30T12:00:00.000Z")
const lease = {
  id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  ownerId: "owner-current", leaseOwner: "owner-current", attemptCount: 2, status: "running" as const,
  leaseExpiresAt: new Date(now.getTime() + 60_000), interruptRequestedAt: null, signal: new AbortController().signal,
}
const taskId = "child-1"

function resolvedWait(id: string, stepId: string, sourceAttempt: number) {
  const deadlineAt = new Date(now.getTime() + 30_000).toISOString()
  const outcome = { waitId: id, status: "ready", taskIds: [taskId], deadlineAt, matchedTaskIds: [taskId],
    tasks: [{ taskId, status: "completed", role: "writer", result: { summary: "done" }, failureReason: null }] }
  return {
    id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, parentTaskId: lease.id, stepId,
    idempotencyKey: `wait-key:${id}`, targetTaskIds: [taskId], mode: "any", status: "ready", deadlineAt: new Date(deadlineAt),
    matchedTaskIds: [taskId], result: { request: { targetTaskIds: [taskId], mode: "any", timeoutMs: 1000 }, outcome },
    suspendedAt: now, consumedAt: now, sourceAttempt,
  }
}

function fixture(options: { readonly waits?: ReturnType<typeof resolvedWait>[]; readonly badTarget?: boolean; readonly futureAttempt?: boolean; readonly lostLeaseAtCommit?: boolean } = {}) {
  const waits = options.waits ?? [resolvedWait("wait-1", "source-1", 1)]
  const queryLog: string[] = []
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      queryLog.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: lease.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE OF task")) return { rows: [{
        id: lease.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: lease.rootTaskId,
        parentTaskId: "root-1", status: "running", attemptCount: lease.attemptCount, leaseOwner: lease.ownerId,
        leaseExpiresAt: lease.leaseExpiresAt, interruptRequestedAt: null, turnStatus: "active", rootStatus: "running",
      }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('"leaseExpiresAt" > clock_timestamp()')) {
        return options.lostLeaseAtCommit ? { rows: [], rowCount: 0 } : { rows: [{ id: lease.id }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('SELECT "id", "stepId"')) {
        return { rows: waits.map(wait => ({ id: wait.id, stepId: wait.stepId })), rowCount: waits.length }
      }
      if (sql.includes('FROM "agent_steps"') && sql.includes('WHERE "id" = $1 FOR UPDATE')) {
        const wait = waits.find(item => item.stepId === params[0])
        return wait ? { rows: [{ id: wait.stepId, sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id,
          attempt: options.futureAttempt ? lease.attemptCount + 1 : wait.sourceAttempt, ordinal: 0, status: "completed" }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "agent_steps"') && sql.includes('"ordinal" > $5')) {
        return { rows: [{ id: `next:${params[3]}`, ordinal: 1 }, { id: `later:${params[3]}`, ordinal: 2 }], rowCount: 2 }
      }
      if (sql.includes('FROM "agent_wait_conditions"') && sql.includes('WHERE "id" = $1 FOR UPDATE')) {
        const wait = waits.find(item => item.id === params[0])
        return wait ? { rows: [wait], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR SHARE OF task")) {
        return { rows: options.badTarget ? [] : [{ id: taskId, parentTaskId: lease.id, rootTaskId: lease.rootTaskId,
          sessionId: lease.sessionId, turnId: lease.turnId, userId: lease.userId }], rowCount: options.badTarget ? 0 : 1 }
      }
      throw new Error(`unexpected repair query: ${sql}`)
    },
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) }
  return { pool, client, queryLog, waits }
}

describe("consumed child wait source repair", () => {
  beforeEach(() => { lifecycle.states.clear(); lifecycle.inspected.length = 0; lifecycle.repaired.length = 0 })

  it("repairs the exact legacy source under the current owner while preserving historical attempt and consumed receipt", async () => {
    const fake = fixture()
    lifecycle.states.set("wait-1", "unreconciled")
    await expect(repairConsumedChildWaitSources(fake.pool as never, lease, now)).resolves.toBe(1)
    expect(lifecycle.repaired).toEqual(["wait-1"])
    expect(fake.waits[0]?.consumedAt).toEqual(now)
    expect(fake.queryLog.findIndex(sql => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")))
      .toBeLessThan(fake.queryLog.findIndex(sql => sql.includes("FOR UPDATE OF task")))
    expect(fake.queryLog.findIndex(sql => sql.includes('FROM "agent_steps"') && sql.includes('WHERE "id" = $1 FOR UPDATE')))
      .toBeLessThan(fake.queryLog.findIndex(sql => sql.includes('FROM "agent_wait_conditions"') && sql.includes('WHERE "id" = $1 FOR UPDATE')))
  })

  it("repairs multiple distinct consumed source steps and leaves valid completed receipts untouched", async () => {
    const fake = fixture({ waits: [resolvedWait("wait-old", "source-old", 1), resolvedWait("wait-current", "source-current", 2)] })
    lifecycle.states.set("wait-old", "unreconciled")
    lifecycle.states.set("wait-current", "waiting")
    await expect(repairConsumedChildWaitSources(fake.pool as never, lease, now)).resolves.toBe(1)
    expect(lifecycle.inspected).toEqual(["wait-old", "wait-current"])
    expect(lifecycle.repaired).toEqual(["wait-old"])
  })

  it("fails closed on overflow, future source attempts, or invalid target scope before reconciliation", async () => {
    const overflow = fixture({ waits: Array.from({ length: 257 }, (_, index) => resolvedWait(`wait-${index}`, `step-${index}`, 1)) })
    await expect(repairConsumedChildWaitSources(overflow.pool as never, lease, now)).rejects.toThrow("repair limit")
    const future = fixture({ futureAttempt: true })
    await expect(repairConsumedChildWaitSources(future.pool as never, lease, now)).rejects.toThrow("source step")
    const target = fixture({ badTarget: true })
    await expect(repairConsumedChildWaitSources(target.pool as never, lease, now)).rejects.toThrow("targets changed scope")
    const lost = fixture({ lostLeaseAtCommit: true })
    await expect(repairConsumedChildWaitSources(lost.pool as never, lease, now)).rejects.toThrow("lease expired")
    expect(lost.queryLog).toContain("ROLLBACK")
    expect(lifecycle.repaired).toEqual([])
  })

  it("fails before connecting when the supplied owner lease is stale or interrupted", async () => {
    const fake = fixture()
    await expect(repairConsumedChildWaitSources(fake.pool as never, { ...lease, ownerId: "old-owner" }, now)).rejects.toThrow("Current child lease")
    await expect(repairConsumedChildWaitSources(fake.pool as never, { ...lease, interruptRequestedAt: now }, now)).rejects.toThrow("Current child lease")
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })
})
