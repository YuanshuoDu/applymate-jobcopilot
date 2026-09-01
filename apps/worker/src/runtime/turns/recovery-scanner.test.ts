import { describe, expect, it, vi } from "vitest"

import { dispatchPendingTurnOutbox, persistTurnDispatch, reclaimExpiredTurns, recoverTurnQueue, turnJobId } from "./recovery-scanner.js"

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

  it("re-enqueues pending DB intents with a deterministic BullMQ job id", async () => {
    const fake = pool([{ id: "outbox_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" } }])
    const queue = { add: vi.fn().mockResolvedValue({ id: turnJobId("turn_1") }) }
    await dispatchPendingTurnOutbox(fake.pool, queue)
    expect(queue.add).toHaveBeenCalledWith("turn", { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, { jobId: turnJobId("turn_1"), attempts: 5 })
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
