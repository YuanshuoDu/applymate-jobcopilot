import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { drainAgentWakeups, resumeAgentTurn } from "./consumer.js"
import type { AgentTurnWakeupPayload } from "./types.js"

const wakeup: AgentTurnWakeupPayload = {
  eventId: "event_wakeup", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:question:q1",
  waitKind: "question", waitId: "q1", toolCallId: "call_1", status: "answered", nextTurnRevision: 6,
}

type FakeOptions = {
  outbox?: boolean
  sessionSequenceRows?: Array<string | bigint | null>
  sessionStatus?: string
  turnStatus?: string
  turnUpdateRows?: number
}

function fakePool(options: FakeOptions = {}) {
  const calls: Array<[string, unknown[] | undefined]> = []
  let outboxDelivered = false
  let sequenceCall = 0
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id", "payload"')) {
        if (options.outbox === false || outboxDelivered) return { rows: [], rowCount: 0 }
        outboxDelivered = true
        return {
          rows: [{ id: "outbox_1", payload: {
            eventId: wakeup.eventId, sessionId: wakeup.sessionId, turnId: wakeup.turnId, itemId: wakeup.itemId,
            type: "turn.wakeup", payload: {
              waitKind: wakeup.waitKind, waitId: wakeup.waitId, itemId: wakeup.itemId,
              toolCallId: wakeup.toolCallId, status: wakeup.status, nextTurnRevision: wakeup.nextTurnRevision,
            },
          } }], rowCount: 1,
        }
      }
      if (sql.includes('SELECT "userId", "status" FROM "agent_sessions"')) {
        return { rows: [{ userId: "user_1", status: options.sessionStatus ?? "running" }], rowCount: 1 }
      }
      if (sql.includes("SELECT set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT turn."userId"')) {
        return { rows: [{ userId: "user_1", status: options.turnStatus ?? "waiting_for_user", revision: 6 }], rowCount: 1 }
      }
      if (sql.includes('SELECT "status", "content"')) {
        return { rows: [{ status: "completed", content: { toolCallId: "call_1", answer: "secret-answer" } }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns" AS turn')) {
        const rowCount = options.turnUpdateRows ?? 1
        return { rows: [], rowCount }
      }
      if (sql.includes('UPDATE "agent_sessions" AS session')) {
        const configured = options.sessionSequenceRows?.[sequenceCall++]
        const eventSequence = configured === undefined ? "10" : configured
        return eventSequence === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ eventSequence }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_events"')) return { rows: [], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE "agent_outbox" SET "publishedAt"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, calls }
}

function hasCall(calls: Array<[string, unknown[] | undefined]>, fragment: string): boolean {
  return calls.some(([sql]) => sql.includes(fragment))
}

function hasWrite(calls: Array<[string, unknown[] | undefined]>): boolean {
  return calls.some(([sql]) => sql.includes('UPDATE "agent_turns"') || sql.includes('UPDATE "agent_sessions"') || sql.includes('INSERT INTO'))
}

describe("Agent wakeup consumer", () => {
  it("locks the session first, sets the tenant, and resumes the same Turn", async () => {
    const fake = fakePool()
    const result = await resumeAgentTurn(fake.pool, wakeup)

    expect(result).toMatchObject({ status: "resumed", turnId: "turn_1", itemId: wakeup.itemId, toolCallId: "call_1" })
    const sessionIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const configIndex = fake.calls.findIndex(([sql]) => sql.includes("SELECT set_config"))
    const turnIndex = fake.calls.findIndex(([sql]) => sql.includes('SELECT turn."userId"'))
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(configIndex).toBeGreaterThan(sessionIndex)
    expect(turnIndex).toBeGreaterThan(configIndex)
    expect(fake.calls[sessionIndex]?.[0]).toContain("FOR UPDATE")

    const resumeEvent = fake.calls.find(([sql]) => sql.includes("'turn.resumed'"))
    expect(resumeEvent).toBeDefined()
    expect(JSON.stringify(fake.calls)).not.toContain("secret-answer")
    const turnUpdate = fake.calls.find(([sql]) => sql.includes('UPDATE "agent_turns" AS turn'))
    expect(turnUpdate?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(turnUpdate?.[1]).toContain(6)
  })

  it("claims and marks durable wakeups after the same-lineage resume", async () => {
    const fake = fakePool()
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)
    expect(hasCall(fake.calls, 'UPDATE "agent_outbox" SET "publishedAt"')).toBe(true)
    expect(hasCall(fake.calls, "'turn.resumed'")).toBe(true)
    expect(hasCall(fake.calls, "COMMIT")).toBe(true)
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
    const fake = fakePool({ turnStatus: "queued" })
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
})
