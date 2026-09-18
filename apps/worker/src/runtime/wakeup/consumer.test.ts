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
  sessionStatus?: string
  sessionSequenceRows?: Array<string | bigint | null>
  turn?: { userId: string; status: string; revision: number } | null
  item?: { status: string; content: unknown } | null
  event?: { sessionId: string; turnId: string; itemId: string | null; type: string; payload: unknown } | null
  failEventOnce?: boolean
  turnUpdateRows?: number
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
  let sessionSequenceCall = 0
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
      if (sql.includes('SELECT "userId", "status" FROM "agent_sessions"')) {
        return { rows: [{ userId: "user_1", status: options.sessionStatus ?? "running" }], rowCount: 1 }
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
      if (sql.includes('UPDATE "agent_sessions"')) {
        const configured = options.sessionSequenceRows?.[sessionSequenceCall++]
        const eventSequence = configured === undefined ? "10" : configured
        return eventSequence === null ? { rows: [], rowCount: 0 } : { rows: [{ eventSequence }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns"')) {
        const rowCount = options.turnUpdateRows ?? 1
        if (rowCount === 1 && sql.includes("SET \"status\" = 'queued'")) turn = turn ? { ...turn, status: "queued", revision: turn.revision + 1 } : turn
        return { rows: [], rowCount }
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

function hasCall(calls: Array<[string, unknown[] | undefined]>, fragment: string): boolean {
  return calls.some(([sql]) => sql.includes(fragment))
}

function hasWrite(calls: Array<[string, unknown[] | undefined]>): boolean {
  return calls.some(([sql]) => sql.includes('UPDATE "agent_turns"') || sql.includes('UPDATE "agent_sessions"') || sql.includes('INSERT INTO'))
}

describe("Agent wakeup consumer", () => {
  it("resumes the same Turn and preserves the original toolCallId", async () => {
    const fake = fakePool()
    const result = await resumeAgentTurn(fake.pool, wakeup)

    expect(result).toMatchObject({ status: "resumed", turnId: "turn_1", itemId: wakeup.itemId, toolCallId: "call_1" })
    const resumeEvent = fake.calls.find(([sql]) => sql.includes("'turn.resumed'"))
    expect(resumeEvent).toBeDefined()
    expect(JSON.stringify(fake.calls)).not.toContain("secret-answer")
    expect(fake.calls.some(([sql, params]) => sql.includes('UPDATE "agent_turns" AS turn') && sql.includes('SET "status" = \'queued\'') && params?.includes(6))).toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes('session."userId" = turn."userId"'))).toBe(true)
  })

  it("accepts the canonical waitId used by Gmail OAuth question items", async () => {
    const fake = fakePool({ item: {
      status: "completed",
      content: { waitKind: "question", oauth: true, waitId: "q1", toolCallId: "call_1" },
    } })

    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "resumed" })
    expect(fake.calls.some(([sql]) => sql.includes("SET \"status\" = 'queued'"))).toBe(true)
  })

  it("claims and marks durable wakeups after the same-lineage resume", async () => {
    const fake = fakePool()
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)
    expect(fake.outboxUpdates).toEqual([{ id: "outbox_1", lastError: null }])
    const pendingSelect = fake.calls.find(([sql]) => sql.includes('FROM "agent_outbox"') && sql.includes('"publishedAt" IS NULL'))
    expect(pendingSelect?.[0]).toContain('LIMIT $2 FOR UPDATE SKIP LOCKED')
    expect(pendingSelect?.[0]).not.toContain('FOR UPDATE SKIP LOCKED LIMIT')
    expect(fake.calls.some(([sql]) => sql === "COMMIT")).toBe(true)
  })

  it.each(["aborted", "archived"])("ignores a %s session before touching its Turn", async (sessionStatus) => {
    const fake = fakePool({ sessionStatus })
    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "ignored" })

    expect(hasWrite(fake.calls)).toBe(false)
    expect(hasCall(fake.calls, "SELECT set_config")).toBe(false)
  })

  it.each(["aborted", "archived"])("marks a %s wakeup consumed without resuming", async (sessionStatus) => {
    const fake = fakePool({ sessionStatus })
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)

    expect(hasCall(fake.calls, 'UPDATE "agent_outbox" SET "publishedAt"')).toBe(true)
    expect(hasCall(fake.calls, 'UPDATE "agent_turns"')).toBe(false)
    expect(hasCall(fake.calls, 'UPDATE "agent_sessions"')).toBe(false)
    expect(hasCall(fake.calls, "INSERT INTO")).toBe(false)
  })

  it("keeps duplicate queued delivery idempotent without item or event writes", async () => {
    const fake = fakePool({ turn: { userId: "user_1", status: "queued", revision: 7 } })
    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "already_resumed" })
    expect(hasCall(fake.calls, 'SELECT "status", "content"')).toBe(false)
    expect(hasCall(fake.calls, "INSERT INTO")).toBe(false)
  })

  it("treats a fenced Turn update miss as an already-resumed no-op", async () => {
    const fake = fakePool({ turnUpdateRows: 0 })
    await expect(resumeAgentTurn(fake.pool, wakeup)).resolves.toMatchObject({ status: "already_resumed" })
    expect(hasCall(fake.calls, "INSERT INTO")).toBe(false)
    expect(hasCall(fake.calls, 'UPDATE "agent_sessions"')).toBe(false)
    expect(hasCall(fake.calls, "COMMIT")).toBe(true)
  })

  it("rolls back when the session closes before the resume event sequence", async () => {
    const fake = fakePool({ sessionSequenceRows: [null] })
    await expect(resumeAgentTurn(fake.pool, wakeup)).rejects.toThrow("sequence is unavailable")
    expect(hasCall(fake.calls, "ROLLBACK")).toBe(true)
    expect(hasCall(fake.calls, 'INSERT INTO "agent_events"')).toBe(false)
    expect(hasCall(fake.calls, 'INSERT INTO "agent_outbox"')).toBe(false)
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
