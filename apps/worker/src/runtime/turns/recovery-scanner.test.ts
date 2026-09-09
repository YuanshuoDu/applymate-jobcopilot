import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import { dispatchPendingTurnOutbox, persistTurnDispatch, reclaimExpiredTurns, recoverTurnQueue, turnJobId } from "./recovery-scanner.js"
import { markTurnDispatchClaimed } from "./turn-queue.js"

function pool(rows: unknown[] = []) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes("WITH stale")) return { rows: [{ id: "turn_1", sessionId: "session_1", leaseVersion: 9 }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"') && sql.includes('SELECT')) return { rows, rowCount: rows.length }
      if (sql.includes('FROM "agent_turns"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, client, calls }
}

describe("Turn recovery scanner", () => {
  it("rejects an invalid dispatch batch size before touching the database", async () => {
    const fake = pool()
    await expect(dispatchPendingTurnOutbox(fake.pool, { add: vi.fn() }, 0)).rejects.toThrow("Turn dispatch limit must be positive")
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })

  it("reclaims only stale in-progress rows and increments their fence", async () => {
    const fake = pool([{ id: "turn_1", sessionId: "session_1", leaseVersion: 9 }])
    const result = await reclaimExpiredTurns(fake.pool, new Date("2026-09-01T00:00:00.000Z"), 50)
    expect(result).toEqual([{ turnId: "turn_1", sessionId: "session_1", previousLeaseVersion: 8 }])
    const sql = fake.calls.find(([text]) => text.includes("WITH stale"))?.[0] ?? ""
    expect(sql).toContain("status\" = 'in_progress'")
    expect(sql).toContain("SKIP LOCKED")
  })

  it("persists a deduplicated dispatch intent before queueing", async () => {
    const fake = pool()
    await persistTurnDispatch(fake.pool, { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" })
    expect(fake.calls.some(([sql]) => sql.includes("ON CONFLICT (\"idempotencyKey\") DO NOTHING"))).toBe(true)
    expect(fake.calls.some(([, params]) => params?.includes("agent.turn.dispatch"))).toBe(true)
  })

  it("uses a colon-free generation id so a resumed Turn is not hidden by a completed job", async () => {
    const completedJobIds = new Set<string>()
    const addedJobIds: string[] = []
    const state = { attemptCount: 0, published: false }
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM "agent_outbox"') && sql.includes("SELECT")) {
          return state.published ? { rows: [], rowCount: 0 } : {
            rows: [{ id: "dispatch_1", payload: { turnId: "turn:1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: state.attemptCount }], rowCount: 1,
          }
        }
        if (sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) {
          if (!state.published) {
            state.published = true
            state.attemptCount += 1
          }
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('ON CONFLICT ("idempotencyKey") DO UPDATE')) {
          state.published = false
          state.attemptCount += 1
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const fakePool = { connect: vi.fn().mockResolvedValue(client) }
    const queue = {
      add: vi.fn(async (_name: string, _payload: unknown, options?: { jobId?: string }) => {
        if (options?.jobId && !completedJobIds.has(options.jobId)) {
          completedJobIds.add(options.jobId)
          addedJobIds.push(options.jobId)
        }
      }),
    }

    await dispatchPendingTurnOutbox(fakePool, queue)
    await markTurnDispatchClaimed(fakePool, { turnId: "turn:1", sessionId: "session_1", ownerId: "owner_1" })
    await persistTurnDispatch(fakePool, { turnId: "turn:1", sessionId: "session_1", ownerId: "owner_1" }, true)
    await dispatchPendingTurnOutbox(fakePool, queue)
    await dispatchPendingTurnOutbox(fakePool, queue)

    expect(addedJobIds).toEqual([turnJobId("turn:1", 0), turnJobId("turn:1", 2)])
    expect(addedJobIds.every((id) => !id.includes(":"))).toBe(true)
    expect(queue.add).toHaveBeenCalledWith("turn", expect.anything(), expect.objectContaining({ jobId: turnJobId("turn:1", 2) }))
    expect(client.query.mock.calls.filter(([sql]) => sql.includes('WHERE "id" = $1 AND "publishedAt" IS NULL')).length).toBe(2)
  })

  it("re-enqueues pending DB intents with a deterministic BullMQ job id", async () => {
    const fake = pool([{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: 4 }])
    const queue = { add: vi.fn().mockResolvedValue({ id: turnJobId("turn_1") }) }
    await dispatchPendingTurnOutbox(fake.pool, queue)
    expect(queue.add).toHaveBeenCalledWith("turn", { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, { jobId: turnJobId("turn_1", 4), attempts: 5 })
  })

  it("records queue add failures without publishing the outbox row", async () => {
    const fake = pool([{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: 4 }])
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) }
    await expect(dispatchPendingTurnOutbox(fake.pool, queue)).rejects.toThrow("redis unavailable")
    const failure = fake.calls.find(([sql]) => sql.includes('SET "attemptCount" = "attemptCount" + 1'))
    expect(failure?.[0]).toContain('"publishedAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "publishedAt" END')
    expect(failure?.[1]).toEqual(["outbox_1", "queue_add_failed", false])
  })

  it("keeps the generation unchanged when publish bookkeeping fails after enqueue", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes('FROM "agent_outbox"') && sql.includes("SELECT")) return { rows: [{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptCount: 4 }], rowCount: 1 }
        if (sql.includes('WHERE "id" = $1 AND "publishedAt" IS NULL')) throw new Error("database unavailable")
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const fakePool = { connect: vi.fn().mockResolvedValue(client) }
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await expect(dispatchPendingTurnOutbox(fakePool, queue)).rejects.toThrow("turn_dispatch_delivery_uncertain")
    expect(queue.add).toHaveBeenCalledWith("turn", expect.anything(), expect.objectContaining({ jobId: turnJobId("turn_1", 4) }))
    expect(calls.filter(([sql]) => sql.includes('SET "attemptCount" = "attemptCount" + 1')).length).toBe(0)
  })

  it("repairs queued or reclaimed work even when the queue add is unavailable", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes("WITH stale")) return { rows: [{ id: "turn_1", sessionId: "session_1", leaseVersion: 2 }], rowCount: 1 }
        if (sql.includes('FROM "agent_outbox"') && sql.includes("SELECT")) return { rows: [{ id: "dispatch_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_2" } }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const fake = { pool: { connect: vi.fn().mockResolvedValue(client) }, calls }
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) }
    await expect(recoverTurnQueue(fake.pool, queue, "owner_2", new Date("2026-09-01T00:00:00.000Z"))).rejects.toThrow("redis unavailable")
    expect(fake.calls.some(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(true)
  })
})
