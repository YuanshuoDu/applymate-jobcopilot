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

  it("writes a mixed existing/new event batch atomically and restores a missing outbox", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    let eventLookups = 0
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_events"')) {
        eventLookups += 1
        return eventLookups === 1
          ? { rows: [{ id: "existing-event", taskId: owner.taskId, turnId: owner.turnId, itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: null, sequence: 4n, actor: "orchestrator", payload: { marker: "a" } }] }
          : { rows: [] }
      }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }] }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 5n }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await expect(store.appendEvents?.([
      { owner, id: "requested-existing", itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: null, idempotencyKey: "plan-event-a", payload: { marker: "a" } },
      { owner, id: "new-event", itemId: null, type: "plan.observation", correlationId: "plan-1", causationId: "requested-existing", idempotencyKey: "plan-event-b", payload: { marker: "b" } },
    ])).resolves.toEqual([{ id: "existing-event" }, { id: "new-event" }])
    expect(calls.filter(call => call.sql === "BEGIN")).toHaveLength(1)
    expect(calls.filter(call => call.sql === "COMMIT")).toHaveLength(1)
    expect(calls.some(call => call.sql === "ROLLBACK")).toBe(false)
    expect(calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(1)
    expect(calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toHaveLength(2)
    const newEventInsert = calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))[0]
    expect(newEventInsert?.values).toContain("new-event")
    expect(newEventInsert?.values).toContain("existing-event")
    const outboxInserts = calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(outboxInserts[0]?.sql).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING')
    expect(outboxInserts[1]?.sql).not.toContain("ON CONFLICT")
  })

  it("rolls back the entire batch when a later event insert fails", async () => {
    const calls: string[] = []
    let eventInserts = 0
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql.includes('INSERT INTO "agent_events"')) { eventInserts += 1; if (eventInserts === 2) throw new Error("batch insert failed") }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }] }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 1n }] }
      if (sql.includes('FROM "agent_events"')) return { rows: [] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    const input = (id: string, causationId: string | null) => ({ owner, id, itemId: null, type: "plan.observation", correlationId: "plan-rollback", causationId, idempotencyKey: `rollback:${id}`, payload: { id } })
    await expect(store.appendEvents!([input("event-a", null), input("event-b", "event-a")])).rejects.toThrow("batch insert failed")
    expect(calls.filter(sql => sql === "BEGIN")).toHaveLength(1)
    expect(calls.filter(sql => sql === "COMMIT")).toHaveLength(0)
    expect(calls.filter(sql => sql === "ROLLBACK")).toHaveLength(1)
  })

  it("transitions only the leased in-progress Turn to waiting_for_user", async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.waitForUser?.({ owner, now })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('"status" = \'in_progress\''), [now, owner.turnId, owner.sessionId, owner.userId, owner.ownerId, owner.leaseVersion, owner.taskId])
  })

  it("records child events as subagent actor while preserving root orchestration actor", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes("FROM \"agent_events\"")) return { rows: [] }
      if (sql.includes('SELECT turn."id"')) return { rows: [{ id: "turn-1" }] }
      if (sql.includes("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: 1n }] }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const store = createPgTurnEngineStore({ connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">)
    await store.appendEvent({ owner: childOwner, id: "child-event", itemId: null, type: "tool.result", correlationId: "child-1", causationId: null, idempotencyKey: "child-key", payload: {} })
    await store.appendEvent({ owner, id: "root-event", itemId: null, type: "turn.started", correlationId: "turn-1", causationId: null, idempotencyKey: "root-key", payload: {} })
    const eventInserts = calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(eventInserts[0]?.values).toContain("subagent")
    expect(eventInserts[1]?.values).toContain("orchestrator")
    const outboxInserts = calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(JSON.parse(String(outboxInserts[0]?.values?.[3])).actor).toBe("subagent")
    expect(JSON.parse(String(outboxInserts[1]?.values?.[3])).actor).toBe("orchestrator")
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
