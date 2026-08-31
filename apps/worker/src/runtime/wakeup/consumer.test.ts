import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { drainAgentWakeups, resumeAgentTurn } from "./consumer.js"
import type { AgentTurnWakeupPayload } from "./types.js"

const wakeup: AgentTurnWakeupPayload = {
  eventId: "event_wakeup", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:question:q1",
  waitKind: "question", waitId: "q1", toolCallId: "call_1", status: "answered", nextTurnRevision: 6,
}

function fakePool(options: { outbox?: boolean } = {}) {
  const calls: Array<[string, unknown[] | undefined]> = []
  let outboxDelivered = false
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT turn."userId"')) return { rows: [{ userId: "user_1", status: "waiting_for_user", revision: 6 }], rowCount: 1 }
      if (sql.includes('SELECT set_config')) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT "status", "content"')) return { rows: [{ status: "completed", content: { toolCallId: "call_1", answer: "secret-answer" } }], rowCount: 1 }
      if (sql.includes('SELECT "id", "payload"')) {
        if (options.outbox === false || outboxDelivered) return { rows: [], rowCount: 0 }
        outboxDelivered = true
        return { rows: [{ id: "outbox_1", payload: { eventId: wakeup.eventId, sessionId: wakeup.sessionId, turnId: wakeup.turnId, itemId: wakeup.itemId, type: "turn.wakeup", payload: { waitKind: wakeup.waitKind, waitId: wakeup.waitId, itemId: wakeup.itemId, toolCallId: wakeup.toolCallId, status: wakeup.status, nextTurnRevision: wakeup.nextTurnRevision } } }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "10" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, calls }
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
  })

  it("claims and marks durable wakeups after the same-lineage resume", async () => {
    const fake = fakePool()
    await expect(drainAgentWakeups(fake.pool, 1)).resolves.toBe(1)
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_outbox" SET "publishedAt"'))).toBe(true)
    expect(fake.calls.some(([sql]) => sql === "COMMIT")).toBe(true)
  })
})
