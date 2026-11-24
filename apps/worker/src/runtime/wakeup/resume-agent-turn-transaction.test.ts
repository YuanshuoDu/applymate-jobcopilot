import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { resumeAgentTurn } from "./resume-agent-turn-transaction.js"
import type { AgentTurnWakeupPayload } from "./types.js"

describe("Agent wakeup resume transaction", () => {
  it("rolls back and releases when a direct group payload carries unsupported fields", async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 } }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
    const payload = {
      eventId: "event_1", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:approval-set:set_1",
      waitKind: "approval_set", waitId: "set_1", toolCallId: null, status: "resolved", nextTurnRevision: 8,
      unrecognized: true,
    } as AgentTurnWakeupPayload

    await expect(resumeAgentTurn(pool, payload)).rejects.toMatchObject({ code: "schema_invalid_payload" })
    expect(statements).toEqual(["BEGIN", "ROLLBACK"])
    expect(client.release).toHaveBeenCalledOnce()
  })
})
