import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgGmailEvidencePort, createPgGmailOAuthWaitPort } from "./gmail-store.js"

describe("Postgres Gmail evidence and OAuth stores", () => {
  it("queries evidence and reservations within the supplied tenant", async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const pool = { query, connect: vi.fn() } as unknown as Pick<pg.Pool, "query" | "connect">
    const evidence = createPgGmailEvidencePort(pool)
    await evidence.findSendEvidence("user-a", "send-a")
    await evidence.hasSendReservation("user-a", "send-a")
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('session."userId" = $1'), ["user-a", "gmail-send:send-a:evidence"])
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('"userId" = $1'), ["user-a", "send-a"])
  })

  it("creates an origin-Turn OAuth wait without token or private content", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        if (sql.includes('FROM "agent_turns"')) return { rows: [{ revision: 4 }] }
        if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 9 }] }
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "query" | "connect">
    const result = await createPgGmailOAuthWaitPort(pool).suspend({
      context: { scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", toolCallId: "call-a", signal: new AbortController().signal, capabilities: [], reportProgress: vi.fn(async () => {}) },
      reason: "gmail_reauthorization_required",
    })
    expect(result.reconnectUrl).toContain(`agentWaitId=${result.waitId}`)
    expect(JSON.stringify(calls)).not.toContain("access-token")
    expect(JSON.stringify(calls)).not.toContain("private body")
    expect(calls.some(({ sql, values }) => sql.includes('"userId" = $3') && values?.includes("user-a"))).toBe(true)
  })
})
