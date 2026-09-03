import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgTurnEngineStore } from "./turn-engine-store.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
}
const now = new Date("2026-09-01T00:00:10.000Z")

describe("PostgreSQL TurnEngine store", () => {
  it("fences new Steps and Items with the active lease and current time", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      return sql.includes("INSERT INTO \"agent_steps\"") ? { rows: [{ id: "step-1" }], rowCount: 1 } : { rows: [{ id: "item-1", revision: 0 }], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.startStep({ lease, stepId: "step-1", ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now })).resolves.toEqual({ id: "step-1" })
    await expect(store.createItem({ lease, itemId: "item-1", stepId: "step-1", type: "agent_message", status: "started", phase: "commentary", content: { text: "" }, now })).resolves.toEqual({ id: "item-1", revision: 0 })
    expect(calls[0].sql).toContain("$10")
    expect(calls[0].values).toContain(now)
    expect(calls[1].sql).toContain("$10")
    expect(calls[1].values).toContain(now)
  })

  it("writes an event and its outbox record in one transaction", async () => {
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes("FROM \"agent_events\"")) return { rows: [] }
      if (sql.includes("FROM \"agent_turns\"")) return { rows: [{ id: "turn-1" }] }
      if (sql.includes("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: 1n }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvent({ lease, id: "event-1", itemId: null, type: "turn.started", correlationId: "turn-1", causationId: null, idempotencyKey: "key-1", payload: { ok: true } })).resolves.toEqual({ id: "event-1" })
    expect(calls[0]).toBe("BEGIN")
    expect(calls).toContain("COMMIT")
    expect(calls.some((sql) => sql.includes("INSERT INTO \"agent_events\""))).toBe(true)
    expect(calls.some((sql) => sql.includes("INSERT INTO \"agent_outbox\""))).toBe(true)
  })

  it("transitions only the leased in-progress Turn to waiting_for_user", async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.waitForUser?.({ lease, now })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('"status" = \'in_progress\''), [now, lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion])
  })
})
