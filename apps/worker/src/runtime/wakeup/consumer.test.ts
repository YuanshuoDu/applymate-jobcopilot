import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { drainAgentWakeups, resumeAgentTurn } from "./consumer.js"
import type { AgentTurnWakeupPayload } from "./types.js"

const wakeup: AgentTurnWakeupPayload = {
  eventId: "event_wakeup", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:question:q1",
  waitKind: "question", waitId: "q1", toolCallId: "call_1", status: "answered", nextTurnRevision: 6,
}

type FakeOutboxRow = { id: string; aggregateId: string; payload: unknown; publishedAt?: Date | null }
type FakeOptions = {
  rows?: FakeOutboxRow[]
  turn?: { userId: string; status: string; revision: number } | null
  item?: { status: string; content: unknown } | null
  event?: { sessionId: string; turnId: string; itemId: string | null; type: string; payload: unknown } | null
  failEventOnce?: boolean
}

function wakeupEnvelope(payload = wakeup) {
  return {
    eventId: payload.eventId, sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, type: "turn.wakeup",
    payload: {
      waitKind: payload.waitKind, waitId: payload.waitId, itemId: payload.itemId, turnId: payload.turnId,
      toolCallId: payload.toolCallId, status: payload.status, nextTurnRevision: payload.nextTurnRevision,
    },
  }
}

function fakePool(options: FakeOptions = {}) {
  const calls: Array<[string, unknown[] | undefined]> = []
  const rows = new Map((options.rows ?? [{ id: "outbox_1", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() }]).map((row) => [row.id, { ...row, publishedAt: row.publishedAt ?? null }]))
  const outboxUpdates: Array<{ id: string; lastError: unknown }> = []
  let turn = options.turn === undefined ? { userId: "user_1", status: "waiting_for_user", revision: 6 } : options.turn
  const item = options.item === undefined ? { status: "completed", content: { waitKind: "question", questionId: "q1", toolCallId: "call_1", answer: "secret-answer" } } : options.item
  const event = options.event === undefined ? { sessionId: wakeup.sessionId, turnId: wakeup.turnId, itemId: wakeup.itemId, type: "turn.wakeup", payload: wakeupEnvelope().payload } : options.event
  let failEventOnce = options.failEventOnce ?? false
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id", "aggregateId", "payload"') && sql.includes('"publishedAt" IS NULL')) {
        const pending = [...rows.values()].filter((row) => row.publishedAt === null).map(({ publishedAt: _publishedAt, ...row }) => row)
        return { rows: pending, rowCount: pending.length }
      }
      if (sql.includes('SELECT "id", "aggregateId", "payload", "publishedAt"')) {
        const row = rows.get(String(params?.[0]))
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('FROM "agent_events"')) {
        if (failEventOnce) {
          failEventOnce = false
          throw new Error("temporary database failure")
        }
        return { rows: event ? [event] : [], rowCount: event ? 1 : 0 }
      }
      if (sql.includes('SELECT turn."userId"')) return { rows: turn ? [turn] : [], rowCount: turn ? 1 : 0 }
      if (sql.includes('SELECT set_config')) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT "status", "content"')) return { rows: item ? [item] : [], rowCount: item ? 1 : 0 }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "10" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_turns"')) {
        if (sql.includes("SET \"status\" = 'queued'")) turn = turn ? { ...turn, status: "queued", revision: turn.revision + 1 } : turn
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_outbox"')) {
        const id = String(params?.[0])
        const row = rows.get(id)
        if (row && sql.includes('SET "publishedAt"')) row.publishedAt = new Date(0)
        outboxUpdates.push({ id, lastError: params?.[2] })
        return { rows: [], rowCount: row ? 1 : 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, calls, outboxUpdates, rows }
}

describe("Agent wakeup consumer", () => {
  it("resumes the same Turn and preserves the original toolCallId", async () => {
    const fake = fakePool()
    const result = await resumeAgentTurn(fake.pool, wakeup)

    expect(result).toMatchObject({ status: "resumed", turnId: "turn_1", itemId: wakeup.itemId, toolCallId: "call_1" })
    const resumeEvent = fake.calls.find(([sql]) => sql.includes("'turn.resumed'"))
    expect(resumeEvent).toBeDefined()
    expect(JSON.stringify(fake.calls)).not.toContain("secret-answer")
    expect(fake.calls.some(([sql, params]) => sql.includes('UPDATE "agent_turns" SET "status" = \'queued\'') && params?.includes(6))).toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes('session."userId" = turn."userId"'))).toBe(true)
  })

  it("claims and marks durable wakeups after the same-lineage resume", async () => {
    const fake = fakePool()
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)
    expect(fake.outboxUpdates).toEqual([{ id: "outbox_1", lastError: null }])
    expect(fake.calls.some(([sql]) => sql === "COMMIT")).toBe(true)
  })

  it("marks duplicate wakeup rows after one Turn resume", async () => {
    const fake = fakePool({ rows: [
      { id: "duplicate_1", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() },
      { id: "duplicate_2", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() },
    ] })

    await expect(drainAgentWakeups(fake.pool, 2)).resolves.toBe(2)
    expect(fake.outboxUpdates).toEqual([
      { id: "duplicate_1", lastError: null },
      { id: "duplicate_2", lastError: null },
    ])
    expect(fake.calls.filter(([sql]) => sql.includes("SET \"status\" = 'queued'")).length).toBe(1)
  })

  it("terminalizes malformed rows and continues with later wakeups", async () => {
    const fake = fakePool({ rows: [
      { id: "bad", aggregateId: wakeup.sessionId, payload: { type: "turn.wakeup" } },
      { id: "good", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() },
    ] })

    await expect(drainAgentWakeups(fake.pool, 2)).resolves.toBe(2)
    expect(fake.outboxUpdates).toEqual([
      { id: "bad", lastError: "schema_invalid_payload" },
      { id: "good", lastError: null },
    ])
  })

  it("terminalizes stale or mis-scoped wakeups without changing the Turn", async () => {
    const stale = fakePool({
      rows: [{ id: "stale", aggregateId: "other_session", payload: wakeupEnvelope() }],
      turn: { userId: "user_1", status: "waiting_for_user", revision: 7 },
    })

    await expect(drainAgentWakeups(stale.pool, 1)).resolves.toBe(1)
    expect(stale.outboxUpdates).toEqual([{ id: "stale", lastError: "outbox_scope_mismatch" }])
    expect(stale.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)

    const revision = fakePool({ rows: [{ id: "revision", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() }], turn: { userId: "user_1", status: "waiting_for_user", revision: 7 } })
    await expect(drainAgentWakeups(revision.pool, 1)).resolves.toBe(1)
    expect(revision.outboxUpdates).toEqual([{ id: "revision", lastError: "turn_revision_conflict" }])
    expect(revision.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)

    const lineage = fakePool({ rows: [{ id: "lineage", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() }], event: null })
    await expect(drainAgentWakeups(lineage.pool, 1)).resolves.toBe(1)
    expect(lineage.outboxUpdates).toEqual([{ id: "lineage", lastError: "event_lineage_mismatch" }])
    expect(lineage.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)

    const tool = fakePool({ rows: [{ id: "tool", aggregateId: wakeup.sessionId, payload: wakeupEnvelope() }], item: { status: "completed", content: { waitKind: "question", questionId: "q1", toolCallId: "other_call" } } })
    await expect(drainAgentWakeups(tool.pool, 1)).resolves.toBe(1)
    expect(tool.outboxUpdates).toEqual([{ id: "tool", lastError: "tool_lineage_mismatch" }])
    expect(tool.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(false)
  })

  it("records transient processing failures for retry without blocking the drain", async () => {
    const fake = fakePool({ failEventOnce: true })
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(0)
    expect(fake.outboxUpdates).toEqual([{ id: "outbox_1", lastError: "processing_error" }])
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)
    expect(fake.outboxUpdates).toEqual([
      { id: "outbox_1", lastError: "processing_error" },
      { id: "outbox_1", lastError: null },
    ])
  })
})
