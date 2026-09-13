import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import type pg from "pg"
import { dispatchPendingSubagentOutbox, enqueueSubagentTask, persistSubagentDispatch, recoverSubagentQueue, repairMissingSubagentDispatches, startSubagentRecoveryScanner, subagentDispatchKey, subagentJobId } from "./subagent-queue.js"
import type { AgentTreeManager } from "../runtime/subagents/manager.js"
import type { SubagentJobPayload } from "../runtime/subagents/types.js"

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }

type DispatchOptions = { sessionStatus?: string | null; aggregateId?: string; payload?: unknown; sessionMissing?: boolean; sessionMissingAfterScan?: boolean; outboxMissingAfterScan?: boolean; attemptCount?: number }

function fakePool(markError?: Error, options: DispatchOptions = {}) {
  const calls: Array<[string, unknown[]?]> = []
  const outbox = { id: "outbox-1", aggregateId: options.aggregateId ?? "session-1", payload: options.payload ?? payload, publishedAt: null as Date | null, attemptCount: options.attemptCount ?? 0 }
  let scanCompleted = false
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("ORDER BY dispatch.")) {
        scanCompleted = true
        const status = options.sessionStatus === undefined ? "running" : options.sessionStatus
        return status && status !== "aborted" && status !== "archived" ? { rows: [outbox], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT session."id"') && sql.includes('FROM "agent_sessions" AS session')) {
        const status = options.sessionStatus === undefined ? "running" : options.sessionStatus
        return options.sessionMissing || status === null || status === "aborted" || status === "archived" || (scanCompleted && options.sessionMissingAfterScan) ? { rows: [], rowCount: 0 } : { rows: [{ id: outbox.aggregateId }], rowCount: 1 }
      }
      if (sql.includes('SELECT dispatch."id"') && sql.includes('FROM "agent_outbox" AS dispatch')) {
        return options.outboxMissingAfterScan ? { rows: [], rowCount: 0 } : { rows: [{ id: outbox.id }], rowCount: 1 }
      }
      if (markError && sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) throw markError
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool, calls, outbox }
}

type RepairOutbox = { id: string; sessionId: string; key: string; payload: SubagentJobPayload; publishedAt: Date | null; lastError: string | null }
type RepairCandidate = { id: string; sessionId: string; rootTaskId: string; status?: string; rootStatus?: string; turnStatus?: string; sessionStatus?: string; interruptRequestedAt?: string | null; attemptCount?: number; maxAttempts?: number; scopeValid?: boolean }
type RepairOptions = { candidate?: RepairCandidate | null; existing?: RepairOutbox[]; failInsert?: Error; respectExisting?: boolean }

function eligibleCandidate(candidate: RepairCandidate): boolean {
  return (candidate.status ?? "queued") === "queued" || (candidate.status ?? "queued") === "retrying"
    ? (candidate.rootStatus ?? "running") !== "completed" && (candidate.rootStatus ?? "running") !== "failed"
      && (candidate.rootStatus ?? "running") !== "interrupted" && (candidate.rootStatus ?? "running") !== "cancelled"
      && (candidate.rootStatus ?? "running") !== "closed" && (candidate.turnStatus ?? "in_progress") !== "completed"
      && (candidate.turnStatus ?? "in_progress") !== "failed" && (candidate.turnStatus ?? "in_progress") !== "interrupted"
      && (candidate.turnStatus ?? "in_progress") !== "cancelled" && (candidate.sessionStatus ?? "running") !== "aborted"
      && (candidate.sessionStatus ?? "running") !== "archived" && candidate.interruptRequestedAt == null
      && (candidate.attemptCount ?? 0) < (candidate.maxAttempts ?? 1) && candidate.scopeValid !== false
    : false
}

function repairPool(options: RepairOptions = {}) {
  const calls: Array<[string, unknown[]?]> = []
  const outbox = [...(options.existing ?? [])]
  const candidate = options.candidate === undefined ? { id: "task-1", sessionId: "session-1", rootTaskId: "root-1" } : options.candidate
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions" AS session') && sql.includes("LIMIT $2 FOR UPDATE SKIP LOCKED")) {
        return candidate ? { rows: [{ id: candidate.sessionId }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE OF task")) {
        const key = candidate ? subagentDispatchKey(candidate.id) : ""
        const exists = outbox.some(row => row.key === key)
        const rows = candidate && eligibleCandidate(candidate) && (options.respectExisting === false || !exists) ? [candidate] : []
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("ORDER BY dispatch.")) {
        const sessionStatus = candidate?.sessionStatus ?? "running"
        const row = outbox.find(item => item.publishedAt === null)
        return row && sessionStatus !== "aborted" && sessionStatus !== "archived" ? {
          rows: [{ id: row.id, aggregateId: row.sessionId, payload: row.payload, attemptCount: 0 }], rowCount: 1,
        } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT session."id"') && sql.includes('FROM "agent_sessions" AS session')) {
        const sessionStatus = candidate?.sessionStatus ?? "running"
        return sessionStatus !== "aborted" && sessionStatus !== "archived" ? { rows: [{ id: outbox[0]?.sessionId ?? "session-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT dispatch."id"') && sql.includes('FROM "agent_outbox" AS dispatch')) {
        const row = outbox.find(item => item.publishedAt === null)
        return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.startsWith('INSERT INTO "agent_outbox"')) {
        if (options.failInsert) throw options.failInsert
        const key = String(params?.[3])
        if (outbox.some(row => row.key === key)) return { rows: [], rowCount: 0 }
        outbox.push({ id: String(params?.[0]), sessionId: String(params?.[2]), key, payload: JSON.parse(String(params?.[4])) as SubagentJobPayload, publishedAt: null, lastError: null })
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) {
        const row = outbox.find(item => item.id === String(params?.[0])); if (row) row.publishedAt = new Date()
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SET "attemptCount" = "attemptCount" + 1')) {
        const row = outbox.find(item => item.id === String(params?.[0])); if (row) row.lastError = String(params?.[1])
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool, calls, client, outbox }
}

describe("Subagent queue", () => {
  it("uses a strict payload and deterministic job id", async () => {
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await enqueueSubagentTask(queue, payload)
    expect(queue.add).toHaveBeenCalledWith("subagent", payload, { jobId: subagentJobId("task-1", 0), attempts: 3 })
    await expect(enqueueSubagentTask(queue, { ...payload, extra: true } as never)).rejects.toThrow("Invalid")
  })

  it("persists idempotent dispatch intent before queue delivery", async () => {
    const fake = fakePool()
    await persistSubagentDispatch(fake.pool, payload)
    expect(fake.calls.some(([sql]) => sql.includes("ON CONFLICT (\"idempotencyKey\") DO NOTHING"))).toBe(true)
    expect(fake.calls.some(([, params]) => params?.includes(subagentDispatchKey("task-1")))).toBe(true)
    const insert = fake.calls.find(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))
    expect(insert?.[1]?.[2]).toBe("session-1")
  })

  it.each(["aborted", "archived", null] as const)("does not reset a %s session dispatch", async sessionStatus => {
    const fake = fakePool(undefined, { sessionStatus })
    await expect(persistSubagentDispatch(fake.pool, payload, true)).resolves.toBeUndefined()
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
  })

  it("does not reset a missing session dispatch", async () => {
    const fake = fakePool(undefined, { sessionMissing: true })
    await expect(persistSubagentDispatch(fake.pool, payload, true)).resolves.toBeUndefined()
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("resets an open %s session dispatch", async sessionStatus => {
    const fake = fakePool(undefined, { sessionStatus })
    await persistSubagentDispatch(fake.pool, payload, true)
    const lockIndex = fake.calls.findIndex(([sql]) => sql.includes('SELECT session."id"') && sql.includes("FOR UPDATE"))
    const insertIndex = fake.calls.findIndex(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))
    expect(lockIndex).toBeGreaterThan(-1)
    expect(lockIndex).toBeLessThan(insertIndex)
    expect(fake.calls[lockIndex]?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(fake.calls[insertIndex]?.[0]).toContain("WHERE EXISTS")
    expect(fake.calls[insertIndex]?.[0]).toContain('WHERE "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"')
  })

  it("dispatches pending intents and marks them published only after queue add", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(1)
    expect(queue.add).toHaveBeenCalledWith("subagent", payload, { jobId: subagentJobId("task-1", 0), attempts: 3 })
    const scan = fake.calls.find(([sql]) => sql.includes('SELECT dispatch."id"') && sql.includes("ORDER BY dispatch."))
    expect(scan?.[0]).toMatch(/ORDER BY dispatch\."createdAt" ASC, dispatch\."id" ASC\s+LIMIT \$2 FOR UPDATE OF dispatch, session SKIP LOCKED/)
    expect(scan?.[0]).toContain('session."id" = dispatch."aggregateId"')
    const sessionLock = fake.calls.findIndex(([sql]) => sql.includes('SELECT session."id"') && sql.includes("FOR UPDATE"))
    const outboxLock = fake.calls.findIndex(([sql]) => sql.includes('SELECT dispatch."id"') && sql.includes('WHERE dispatch."id"'))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(sessionLock).toBeLessThan(outboxLock)
    const mark = fake.calls.find(([sql]) => sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP'))
    expect(mark?.[0]).toContain('"publishedAt"')
  })

  it.each(["aborted", "archived", null] as const)("does not queue a %s session", async sessionStatus => {
    const fake = fakePool(undefined, { sessionStatus })
    const queue = { add: vi.fn() }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(0)
    expect(queue.add).not.toHaveBeenCalled()
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("queues an open %s session", async sessionStatus => {
    const fake = fakePool(undefined, { sessionStatus })
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(1)
    expect(queue.add).toHaveBeenCalledTimes(1)
  })

  it("rechecks the session fence after selecting an outbox row", async () => {
    const fake = fakePool(undefined, { sessionMissingAfterScan: true })
    const queue = { add: vi.fn() }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(0)
    expect(queue.add).not.toHaveBeenCalled()
    expect(fake.calls.some(([sql]) => sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP'))).toBe(false)
  })

  it("skips an outbox row already handled after the scan", async () => {
    const fake = fakePool(undefined, { outboxMissingAfterScan: true })
    const queue = { add: vi.fn() }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(0)
    expect(queue.add).not.toHaveBeenCalled()
  })

  it("fails closed when payload session does not match the outbox aggregate", async () => {
    const fake = fakePool(undefined, { payload: { ...payload, sessionId: "other-session" } })
    const queue = { add: vi.fn() }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(0)
    expect(queue.add).not.toHaveBeenCalled()
    expect(fake.calls.some(([sql, params]) => sql.includes('SET "attemptCount" = "attemptCount" + 1') && params?.[1] === "schema_invalid_payload")).toBe(true)
  })

  it("records queue_add_failed and preserves an unpublished row when Redis enqueue fails", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).rejects.toThrow("redis unavailable")
    const mark = fake.calls.find(([sql]) => sql.includes('SET "attemptCount" = "attemptCount" + 1'))
    expect(mark?.[0]).toContain('"publishedAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "publishedAt" END')
    expect(mark?.[1]).toEqual(["outbox-1", "queue_add_failed", false])
  })

  it("fails closed when enqueue succeeds but publication bookkeeping is uncertain", async () => {
    const fake = fakePool(new Error("database unavailable"))
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).rejects.toMatchObject({ code: "subagent_dispatch_delivery_uncertain", message: "subagent_dispatch_delivery_uncertain" })
    expect(queue.add).toHaveBeenCalledWith("subagent", payload, { jobId: subagentJobId("task-1", 0), attempts: 3 })
  })

  it("encodes task IDs and advances the generation after a recovered delivery", async () => {
    expect(subagentJobId("task:with spaces", 4)).toBe("agent-subagent-dGFzazp3aXRoIHNwYWNlcw-4")
    expect(subagentJobId("task:with spaces", 4)).not.toContain(":")
    const fake = fakePool(undefined, { attemptCount: 2 })
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await dispatchPendingSubagentOutbox(fake.pool, queue)
    expect(queue.add).toHaveBeenCalledWith("subagent", payload, { jobId: subagentJobId("task-1", 2), attempts: 3 })
  })

  it("repairs a missing queued dispatch before the normal dispatcher publishes it", async () => {
    const fake = repairPool()
    await expect(repairMissingSubagentDispatches(fake.pool, "repair-worker", 1)).resolves.toBe(1)
    expect(fake.outbox).toHaveLength(1)
    expect(fake.outbox[0]).toMatchObject({ sessionId: "session-1", key: subagentDispatchKey("task-1"), publishedAt: null, payload: { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "repair-worker" } })
    const scan = fake.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE OF task"))
    expect(scan?.[0]).toContain("IN ('queued', 'retrying')")
    expect(scan?.[0]).toContain('task."interruptRequestedAt" IS NULL')
    expect(scan?.[0]).toContain('task."attemptCount" < task."maxAttempts"')
    expect(scan?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(scan?.[0]).toContain('root."status" NOT IN')
    expect(scan?.[0]).toContain('turn."status" NOT IN')
    expect(scan?.[0]).toContain("'subagent-dispatch:' || task.\"id\"")
    expect(scan?.[0]).toContain("LIMIT $3 FOR UPDATE OF task SKIP LOCKED")
    expect(scan?.[1]).toEqual([["session-1"], "agent.subagent.dispatch", 1])
    const sessionLockIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions" AS session') && sql.includes("LIMIT $2 FOR UPDATE SKIP LOCKED"))
    const taskLockIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE OF task"))
    expect(sessionLockIndex).toBeGreaterThan(-1)
    expect(sessionLockIndex).toBeLessThan(taskLockIndex)
    expect(fake.calls[sessionLockIndex]?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    const insert = fake.calls.find(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))
    expect(insert?.[0]).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING')
    expect(insert?.[1]?.[2]).toBe("session-1")
    await expect(dispatchPendingSubagentOutbox(fake.pool, { add: vi.fn().mockResolvedValue(undefined) })).resolves.toBe(1)
    expect(fake.outbox[0]?.publishedAt).not.toBeNull()
  })

  it("keeps repair idempotent for repeated scanners and existing outbox rows", async () => {
    const fake = repairPool({ respectExisting: false })
    await expect(repairMissingSubagentDispatches(fake.pool, "repair-worker", 5)).resolves.toBe(1)
    await expect(repairMissingSubagentDispatches(fake.pool, "other-worker", 5)).resolves.toBe(0)
    expect(fake.outbox).toHaveLength(1)
    const existing = { id: "outbox-existing", sessionId: "session-1", key: subagentDispatchKey("task-1"), payload, publishedAt: new Date(), lastError: null }
    const existingFake = repairPool({ existing: [existing] })
    await expect(repairMissingSubagentDispatches(existingFake.pool, "repair-worker")).resolves.toBe(0)
    expect(existingFake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  const invalidCandidates: Array<[string, Partial<RepairCandidate>]> = [
    ["terminal task", { status: "completed" }], ["terminal root", { rootStatus: "completed" }],
    ["terminal Turn", { turnStatus: "completed" }], ["interrupt requested", { interruptRequestedAt: "2026-09-13T00:00:00.000Z" }],
    ["attempts exhausted", { attemptCount: 2, maxAttempts: 2 }], ["aborted session", { sessionStatus: "aborted" }],
    ["archived session", { sessionStatus: "archived" }], ["missing or cross-scope row", { scopeValid: false }],
  ]
  it.each(invalidCandidates)("skips a %s during repair", async (_label, overrides) => {
    const fake = repairPool({ candidate: { id: "task-1", sessionId: "session-1", rootTaskId: "root-1", ...overrides } })
    await expect(repairMissingSubagentDispatches(fake.pool, "repair-worker")).resolves.toBe(0)
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("repairs before dispatch when invoked through recoverSubagentQueue", async () => {
    const fake = repairPool()
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    const manager = { recover: vi.fn().mockResolvedValue({ rows: [], reclaimed: 0, terminal: 0 }) } as unknown as AgentTreeManager
    await expect(recoverSubagentQueue(fake.pool, queue, manager, 1)).resolves.toMatchObject({ reclaimed: 0, terminal: 0, repaired: 1, dispatched: 1 })
    const repairIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task'))
    const dispatchIndex = fake.calls.findIndex(([sql]) => sql.includes('SELECT dispatch."id"') && sql.includes("ORDER BY dispatch."))
    expect(repairIndex).toBeGreaterThan(-1)
    expect(repairIndex).toBeLessThan(dispatchIndex)
    expect(queue.add).toHaveBeenCalledTimes(1)
  })

  it("leaves a repaired outbox row unpublished when queue delivery fails", async () => {
    const fake = repairPool()
    await expect(repairMissingSubagentDispatches(fake.pool, "repair-worker")).resolves.toBe(1)
    await expect(dispatchPendingSubagentOutbox(fake.pool, { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) })).rejects.toThrow("redis unavailable")
    expect(fake.outbox[0]?.publishedAt).toBeNull()
    expect(fake.outbox[0]?.lastError).toBe("queue_add_failed")
  })

  it("runs one recovery scan immediately and can shut down cleanly", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    const manager = { recover: vi.fn().mockResolvedValue({ rows: [], reclaimed: 0, terminal: 0 }) } as unknown as AgentTreeManager
    const scanner = startSubagentRecoveryScanner(fake.pool, queue, manager, 60_000)
    await scanner.close()
    expect(manager.recover).toHaveBeenCalledTimes(1)
  })
})
