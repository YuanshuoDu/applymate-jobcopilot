import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { SubagentJobPayload } from "../runtime/subagents/types.js"
import { PAUSE_DEFERRED_MARKER, repairDeferredSubagentDispatches, runSubagentQueueJob } from "./subagent-pause-dispatch.js"
import { dispatchPendingSubagentOutbox, subagentJobId } from "./subagent-queue.js"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

type PgSubagentPool = Pick<pg.Pool, "connect">

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }

type DeferOptions = { publishedAt?: Date | null; startedAt?: Date | null; failWrite?: Error; lastError?: string | null }
function deferPool(options: DeferOptions = {}) {
  const calls: Array<[string, unknown[]?]> = []
  const outbox = { id: "dispatch-1", payload: { ...payload } as unknown, publishedAt: options.publishedAt === undefined ? new Date() : options.publishedAt, attemptCount: 3, lastError: options.lastError === undefined ? null : options.lastError }
  const task = { attemptCount: 0 }
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions" AS session') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes("set_config('app.user_id'")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT task."turnId", task."rootTaskId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS root') && sql.includes("FOR UPDATE")) return { rows: [{ id: "root-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE OF task")) return { rows: [{
        id: "task-1", sessionId: "session-1", rootTaskId: "root-1", turnId: "turn-1", status: "queued", startedAt: options.startedAt ?? null,
        attemptCount: task.attemptCount, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
        rootStatus: "running", turnStatus: "in_progress", turnUserId: "user-1",
      }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE")) return { rows: [{
        id: "task-1", sessionId: "session-1", rootTaskId: "root-1", turnId: "turn-1", status: "queued", startedAt: options.startedAt ?? null,
        attemptCount: task.attemptCount, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE")) return { rows: [{ ...outbox }], rowCount: 1 }
      if (sql.startsWith('UPDATE "agent_outbox" SET "lastError" = $2')) {
        if (options.failWrite) throw options.failWrite
        outbox.lastError = String(params?.[1])
        if (outbox.publishedAt === null) {
          outbox.payload = JSON.parse(String(params?.[2])) as unknown
          outbox.attemptCount += 1
        }
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool, calls, outbox, task, client }
}

type RecoveryOptions = { activePause?: boolean; startedAt?: Date | null; marker?: string | null }
function recoveryPool(options: RecoveryOptions = {}) {
  const calls: Array<[string, unknown[]?]> = []
  const task = { id: "task-1", sessionId: "session-1", rootTaskId: "root-1", turnId: "turn-1", status: "queued", startedAt: options.startedAt ?? null, attemptCount: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, rootStatus: "running", turnStatus: "in_progress" }
  const outbox: { id: string; payload: unknown; publishedAt: Date | null; attemptCount: number; lastError: string | null } = {
    id: "dispatch-1", payload: { ...payload }, publishedAt: new Date(), attemptCount: 3,
    lastError: options.marker === undefined ? PAUSE_DEFERRED_MARKER : options.marker,
  }
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 }
      if (sql.includes("LIMIT $3 FOR UPDATE SKIP LOCKED")) return options.activePause || outbox.lastError !== PAUSE_DEFERRED_MARKER || outbox.publishedAt === null || task.startedAt !== null ? { rows: [], rowCount: 0 } : { rows: [{ id: "session-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes("set_config('app.user_id'")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT task."turnId" FROM "sub_agent_tasks"')) return { rows: [{ turnId: "turn-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS root') && sql.includes("FOR UPDATE")) return { rows: [{ id: "root-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
      if (sql.includes('AS "taskId"') && sql.includes("LIMIT $4")) return { rows: [{ taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, userId: "user-1", dispatchId: outbox.id, payload: outbox.payload }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('ORDER BY dispatch."createdAt"')) return outbox.publishedAt === null ? { rows: [{ id: outbox.id, aggregateId: "session-1", payload: outbox.payload, attemptCount: outbox.attemptCount }], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.includes('SELECT session."id", session."status"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", status: "running", userId: "user-1" }], rowCount: 1 }
      if (sql.startsWith('SELECT "id", "turnId" FROM "sub_agent_tasks"')) return { rows: [{ id: task.id, turnId: task.turnId }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE OF task")) {
        if (sql.includes('LEFT JOIN "agent_turns" AS turn')) return { rows: [{ ...task, rootId: task.rootTaskId, rootSessionId: task.sessionId, rootTurnId: task.turnId, turnRowId: task.turnId, turnSessionId: task.sessionId, turnUserId: "user-1", turnStatus: "in_progress", retryDue: true }], rowCount: 1 }
        return sql.includes('WHERE task."id" = $1 AND task."sessionId" = $3')
          ? { rows: [task], rowCount: 1 }
          : task.startedAt === null ? { rows: [{ ...task }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE")) return { rows: [{ ...task }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE")) return outbox.lastError === PAUSE_DEFERRED_MARKER ? { rows: [{ id: outbox.id, aggregateId: "session-1", payload: outbox.payload, attemptCount: outbox.attemptCount, lastError: outbox.lastError }], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.startsWith("SELECT") && sql.includes("pause_request")) return options.activePause ? { rows: [], rowCount: 0 } : { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.startsWith('UPDATE "agent_outbox" SET "payload"')) {
        outbox.payload = JSON.parse(String(params?.[0])) as unknown
        outbox.publishedAt = null
        outbox.attemptCount += 1
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) {
        outbox.publishedAt = new Date()
        outbox.attemptCount += 1
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool, calls, outbox, task }
}

describe("pause-deferred subagent dispatch", () => {
  it("persists the exact pause-denied outcome before returning it to BullMQ", async () => {
    const fake = deferPool()
    const manager = { run: vi.fn().mockResolvedValue({ taskId: "task-1", status: "skipped", reason: "session_pause_requested" }) }
    await expect(runSubagentQueueJob(fake.pool, manager as never, async () => ({ status: "completed" }), payload)).resolves.toMatchObject({ status: "skipped", reason: "session_pause_requested" })
    expect(fake.outbox.lastError).toBe(PAUSE_DEFERRED_MARKER)
    expect(fake.task.attemptCount).toBe(0)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.findIndex(([sql]) => sql.startsWith('UPDATE "agent_outbox" SET "lastError"'))).toBeLessThan(fake.calls.findIndex(([sql]) => sql === "COMMIT"))
  })

  it("does not defer ordinary skips or lease loss", async () => {
    const skipped = deferPool()
    const ordinary = { run: vi.fn().mockResolvedValue({ taskId: "task-1", status: "skipped", reason: "not_available" }) }
    await expect(runSubagentQueueJob(skipped.pool, ordinary as never, async () => ({ status: "completed" }), payload)).resolves.toMatchObject({ reason: "not_available" })
    expect(skipped.pool.connect).not.toHaveBeenCalled()
    const lost = { run: vi.fn().mockResolvedValue({ taskId: "task-1", status: "lease_lost", reason: "expired" }) }
    await expect(runSubagentQueueJob(skipped.pool, lost as never, async () => ({ status: "completed" }), payload)).rejects.toThrow("expired")
    expect(skipped.pool.connect).not.toHaveBeenCalled()
  })

  it("does not mark an active task that was already started", async () => {
    const fake = deferPool({ startedAt: new Date() })
    const manager = { run: vi.fn().mockResolvedValue({ taskId: "task-1", status: "skipped", reason: "session_pause_requested" }) }
    await runSubagentQueueJob(fake.pool, manager as never, async () => ({ status: "completed" }), payload)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
  })

  it("rotates an unpublished uncertain delivery without changing the task attempt", async () => {
    const fake = deferPool({ publishedAt: null })
    const manager = { run: vi.fn().mockResolvedValue({ taskId: "task-1", status: "skipped", reason: "session_pause_requested" }) }
    await runSubagentQueueJob(fake.pool, manager as never, async () => ({ status: "completed" }), payload)
    expect(fake.outbox.attemptCount).toBe(4)
    expect(fake.outbox.payload).toMatchObject({ ...payload, ownerId: expect.stringMatching(/^deferred-/) })
  })

  it("rotates an already-deferred unpublished generation after uncertain publication", async () => {
    const fake = deferPool({ publishedAt: null, lastError: PAUSE_DEFERRED_MARKER })
    const manager = { run: vi.fn().mockResolvedValue({ taskId: "task-1", status: "skipped", reason: "session_pause_requested" }) }
    await runSubagentQueueJob(fake.pool, manager as never, async () => ({ status: "completed" }), payload)
    expect(fake.outbox.lastError).toBe(PAUSE_DEFERRED_MARKER)
    expect(fake.outbox.payload).toMatchObject({ ...payload, ownerId: expect.stringMatching(/^deferred-/) })
    expect((fake.outbox.payload as SubagentJobPayload).ownerId).not.toBe(payload.ownerId)
    expect(fake.outbox.attemptCount).toBe(4)
    expect(fake.task.attemptCount).toBe(0)
  })

  it("leaves BullMQ unacknowledged when durable deferral cannot be written", async () => {
    const fake = deferPool({ failWrite: new Error("database unavailable") })
    const manager = { run: vi.fn().mockResolvedValue({ taskId: "task-1", status: "skipped", reason: "session_pause_requested" }) }
    await expect(runSubagentQueueJob(fake.pool, manager as never, async () => ({ status: "completed" }), payload)).rejects.toThrow("database unavailable")
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
  })

  it("rotates a deferred published delivery once after resume and leaves task attempts alone", async () => {
    const fake = recoveryPool()
    await expect(repairDeferredSubagentDispatches(fake.pool, "recovery-worker", 1)).resolves.toBe(1)
    expect(fake.outbox).toMatchObject({ publishedAt: null, attemptCount: 4, lastError: PAUSE_DEFERRED_MARKER, payload: { ...payload, ownerId: expect.stringMatching(/^recovery-worker-/) } })
    expect(fake.task.attemptCount).toBe(0)
    const session = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions" AS session') && sql.includes("LIMIT $3 FOR UPDATE SKIP LOCKED"))
    const task = fake.calls.findIndex(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE") && !sql.includes("ORDER BY"))
    const dispatch = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("FOR UPDATE"))
    const update = fake.calls.findIndex(([sql]) => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))
    expect(session).toBeGreaterThan(-1)
    expect(session).toBeLessThan(task)
    expect(task).toBeLessThan(dispatch)
    expect(dispatch).toBeLessThan(update)
  })

  it("does not republish during pause, repeat a reset, or select an unmarked child", async () => {
    const paused = recoveryPool({ activePause: true })
    await expect(repairDeferredSubagentDispatches(paused.pool, "recovery-worker", 1)).resolves.toBe(0)
    expect(paused.outbox.publishedAt).not.toBeNull()
    const started = recoveryPool({ startedAt: new Date() })
    await expect(repairDeferredSubagentDispatches(started.pool, "recovery-worker", 1)).resolves.toBe(0)
    const unmarked = recoveryPool({ marker: null })
    await expect(repairDeferredSubagentDispatches(unmarked.pool, "recovery-worker", 1)).resolves.toBe(0)
  })

  it("uses a fresh pending publisher generation after one recovery reset and is idempotent", async () => {
    const fake = recoveryPool()
    await expect(repairDeferredSubagentDispatches(fake.pool, "recovery-worker", 1)).resolves.toBe(1)
    await expect(repairDeferredSubagentDispatches(fake.pool, "another-worker", 1)).resolves.toBe(0)
    expect(fake.calls.filter(([sql]) => sql.startsWith('UPDATE "agent_outbox" SET "payload"'))).toHaveLength(1)
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(1)
    expect(queue.add).toHaveBeenCalledWith("subagent", expect.objectContaining({ ownerId: expect.stringMatching(/^recovery-worker-/) }), { jobId: subagentJobId("task-1", 4), attempts: 3 })
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(0)
    expect(queue.add).toHaveBeenCalledTimes(1)
    expect(fake.outbox.lastError).toBe(PAUSE_DEFERRED_MARKER)
  })
})
