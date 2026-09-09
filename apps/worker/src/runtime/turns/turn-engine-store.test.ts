import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgTurnEngineStore } from "./turn-engine-store.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
}
const now = new Date("2026-09-01T00:00:10.000Z")
const owner = {
  kind: "turn" as const, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
  taskId: "root-turn-1", rootTaskId: "root-turn-1", ownerId: lease.ownerId, leaseVersion: lease.leaseVersion,
  leaseExpiresAt: lease.leaseExpiresAt,
}
const childOwner = {
  kind: "task" as const, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
  taskId: "child-1", rootTaskId: owner.taskId, ownerId: "child-worker", attemptCount: 2, leaseExpiresAt: lease.leaseExpiresAt,
}
function assertDenseBindings(calls: Array<{ sql: string; values?: readonly unknown[] }>) {
  for (const call of calls) {
    if (!call.values) continue
    const indexes = [...call.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
    if (indexes.length === 0) continue
    expect(call.values.length).toBe(Math.max(...indexes))
  }
}

describe("PostgreSQL TurnEngine store", () => {
  it("fences new Steps and Items with the active lease and current time", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id", "ordinal", "taskId"')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-1" }], rowCount: 1 }
      if (sql.includes('MAX("ordinal")')) return { rows: [{ ordinal: 0 }], rowCount: 1 }
      if (sql.includes("INSERT INTO \"agent_steps\"")) return { rows: [{ id: "step-1" }], rowCount: 1 }
      if (sql.includes("INSERT INTO \"agent_items\"")) return { rows: [{ id: "item-1", revision: 0 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.startStep({ owner, stepId: "step-1", ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now })).resolves.toEqual({ id: "step-1", ordinal: 0 })
    await expect(store.createItem({ owner, itemId: "item-1", stepId: "step-1", type: "agent_message", status: "started", phase: "commentary", content: { text: "" }, now })).resolves.toEqual({ id: "item-1", revision: 0 })
    expect(calls.some(({ sql }) => sql.includes("owner_task") && sql.includes("leaseVersion"))).toBe(true)
    expect(calls.some(({ values }) => values?.includes(owner.taskId))).toBe(true)
    assertDenseBindings(calls)
  })

  it("writes an event and its outbox record in one transaction", async () => {
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes("FROM \"agent_events\"")) return { rows: [] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }] }
      if (sql.includes("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: 1n }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvent({ owner, id: "event-1", itemId: null, type: "turn.started", correlationId: "turn-1", causationId: null, idempotencyKey: "key-1", payload: { ok: true } })).resolves.toEqual({ id: "event-1" })
    expect(calls[0]).toBe("BEGIN")
    expect(calls).toContain("COMMIT")
    expect(calls.some((sql) => sql.includes("INSERT INTO \"agent_events\""))).toBe(true)
    expect(calls.some((sql) => sql.includes("INSERT INTO \"agent_outbox\""))).toBe(true)
  })

  it("transitions only the leased in-progress Turn to waiting_for_user", async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.waitForUser?.({ owner, now })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('"status" = \'in_progress\''), [now, owner.turnId, owner.sessionId, owner.userId, owner.ownerId, owner.leaseVersion, owner.taskId])
  })

  it("fences child persistence and allocates a Turn-global ordinal", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id", "ordinal", "taskId"')) return { rows: [], rowCount: 0 }
      if (sql.includes('MAX("ordinal")')) return { rows: [{ ordinal: 7 }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_steps"')) return { rows: [{ id: "child-step" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.startStep({ owner: childOwner, stepId: "task:child-1:step:0", ordinal: 0, attempt: 2, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now })).resolves.toEqual({ id: "child-step", ordinal: 7 })
    await expect(store.recordFinalResponse({ owner: childOwner as never, response: "private", now })).rejects.toThrow(/child final/)
    expect(calls.some(({ sql }) => sql.includes('"rootTaskId"') && sql.includes('"attemptCount"') && sql.includes('"interruptRequestedAt" IS NULL'))).toBe(true)
    expect(calls.some(({ sql }) => sql.includes('MAX("ordinal")') && sql.includes('agent_steps'))).toBe(true)
    assertDenseBindings(calls)
  })

  it("locks the owner before updating a Step or Item", async () => {
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT item."id"')) return { rows: [{ id: "item-1" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_items"')) return { rows: [{ id: "item-1", revision: 1 }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.updateStep({ owner, stepId: "step-1", status: "completed", finishReason: "done", errorCode: null, inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01, now })
    await store.updateItem({ owner, itemId: "item-1", expectedRevision: 0, status: "completed", phase: "commentary", content: { text: "done" }, startedAt: now, completedAt: now, now })
    const locks = calls.reduce<number[]>((indices, sql, index) => sql.includes('SELECT turn."id"') ? [...indices, index] : indices, [])
    const updates = calls.reduce<number[]>((indices, sql, index) => sql.includes('UPDATE "agent_') ? [...indices, index] : indices, [])
    expect(locks).toHaveLength(2)
    expect(locks[0]).toBeLessThan(updates[0])
    expect(locks[1]).toBeLessThan(updates[1])
  })

  it("rejects stale step lineage before create fallback or event linkage", async () => {
    const calls: string[] = []
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id" FROM "agent_steps"') || sql.includes('SELECT item."id"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.createItem({ owner: childOwner, itemId: "item-old", stepId: "step-old", type: "tool_result", status: "started", phase: "commentary", content: {}, now })).rejects.toThrow(/step step-old lineage/)
    await expect(store.appendEvent({ owner: childOwner, id: "event-old", itemId: "item-old", type: "tool.result", correlationId: "turn-1", causationId: null, idempotencyKey: "event-old", payload: {} })).rejects.toThrow(/item item-old lineage/)
    expect(calls.some(sql => sql.includes('INSERT INTO "agent_items"'))).toBe(false)
    expect(calls.some(sql => sql.includes('INSERT INTO "agent_events"'))).toBe(false)
  })
})
