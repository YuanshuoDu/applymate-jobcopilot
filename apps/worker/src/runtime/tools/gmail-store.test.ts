import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgGmailEvidencePort, createPgGmailOAuthWaitPort } from "./gmail-store.js"

type WaitFixtureOptions = {
  sessionExists?: boolean
  sessionStatus?: string
  sessionUserId?: string
  turnExists?: boolean
  failOn?: string
}

function makeWaitFixture(options: WaitFixtureOptions = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const sessionExists = options.sessionExists ?? true
  const sessionStatus = options.sessionStatus ?? "running"
  const sessionUserId = options.sessionUserId ?? "user-a"
  const turnExists = options.turnExists ?? true
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (options.failOn && sql.includes(options.failOn)) throw new Error("fixture query failure")
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [] }
      if (sql.includes('FROM "agent_sessions"') && sql.includes('status" NOT IN') && sql.includes("FOR UPDATE")) {
        const owned = values?.[0] === "session-a" && values?.[1] === sessionUserId
        return { rows: sessionExists && owned && !["aborted", "archived"].includes(sessionStatus) ? [{ id: "session-a" }] : [] }
      }
      if (sql.includes('FROM "agent_turns"')) return { rows: turnExists ? [{ revision: 4 }] : [] }
      if (sql.startsWith('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 9 }] }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "query" | "connect">
  return { calls, client, pool }
}

function waitInput() {
  return {
    context: {
      scope: { userId: "user-a" },
      sessionId: "session-a",
      turnId: "turn-a",
      stepId: "step-a",
      toolCallId: "call-a",
      signal: new AbortController().signal,
      capabilities: [],
      reportProgress: vi.fn(async () => {}),
    },
    reason: "gmail_reauthorization_required" as const,
  }
}

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
    const fixture = makeWaitFixture()
    const result = await createPgGmailOAuthWaitPort(fixture.pool).suspend(waitInput())
    expect(result.reconnectUrl).toContain(`agentWaitId=${result.waitId}`)
    expect(JSON.stringify(fixture.calls)).not.toContain("access-token")
    expect(JSON.stringify(fixture.calls)).not.toContain("private body")
    expect(fixture.calls.some(({ sql, values }) => sql.includes('"userId" = $3') && values?.includes("user-a"))).toBe(true)
    const sqls = fixture.calls.map(({ sql }) => sql)
    const sessionLock = sqls.findIndex((sql) => sql.includes('FROM "agent_sessions"') && sql.includes('status" NOT IN') && sql.includes("FOR UPDATE"))
    const turnLock = sqls.findIndex((sql) => sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE"))
    const itemWrite = sqls.findIndex((sql) => sql.includes('INSERT INTO "agent_items"'))
    const sequenceWrite = sqls.findIndex((sql) => sql.startsWith('UPDATE "agent_sessions"'))
    const eventWrite = sqls.findIndex((sql) => sql.includes('INSERT INTO "agent_events"'))
    expect(sessionLock).toBeGreaterThanOrEqual(0)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(turnLock).toBeLessThan(itemWrite)
    expect(itemWrite).toBeLessThan(sequenceWrite)
    expect(sequenceWrite).toBeLessThan(eventWrite)
    expect(fixture.calls[sessionLock]?.values).toEqual(["session-a", "user-a"])
  })

  it.each([
    ["aborted", { sessionStatus: "aborted" }],
    ["archived", { sessionStatus: "archived" }],
    ["missing", { sessionExists: false }],
    ["cross-user", { sessionUserId: "user-b" }],
  ])("rejects %s sessions before any durable child write", async (_label, options) => {
    const fixture = makeWaitFixture(options)
    await expect(createPgGmailOAuthWaitPort(fixture.pool).suspend(waitInput())).rejects.toThrow("Gmail OAuth wait session is unavailable")
    const sqls = fixture.calls.map(({ sql }) => sql)
    expect(sqls.some((sql) => sql.includes('FROM "agent_turns"'))).toBe(false)
    expect(sqls.some((sql) => sql.includes('INSERT INTO "agent_items"'))).toBe(false)
    expect(sqls.some((sql) => sql.startsWith('UPDATE "agent_sessions"'))).toBe(false)
    expect(sqls.some((sql) => sql.includes('INSERT INTO "agent_events"'))).toBe(false)
    expect(sqls).toContain("ROLLBACK")
    expect(sqls).not.toContain("COMMIT")
  })

  it("rejects a missing origin Turn after taking the session lock", async () => {
    const fixture = makeWaitFixture({ turnExists: false })
    await expect(createPgGmailOAuthWaitPort(fixture.pool).suspend(waitInput())).rejects.toThrow("Gmail OAuth wait is outside the origin Turn")
    const sqls = fixture.calls.map(({ sql }) => sql)
    const sessionLock = sqls.findIndex((sql) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const turnLock = sqls.findIndex((sql) => sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE"))
    expect(sessionLock).toBeGreaterThanOrEqual(0)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(sqls.some((sql) => sql.includes('INSERT INTO "agent_items"'))).toBe(false)
    expect(sqls.some((sql) => sql.startsWith('UPDATE "agent_sessions"'))).toBe(false)
    expect(sqls.some((sql) => sql.includes('INSERT INTO "agent_events"'))).toBe(false)
    expect(sqls).toContain("ROLLBACK")
  })

  it("rolls back when the durable event write fails", async () => {
    const fixture = makeWaitFixture({ failOn: 'INSERT INTO "agent_events"' })
    await expect(createPgGmailOAuthWaitPort(fixture.pool).suspend(waitInput())).rejects.toThrow("fixture query failure")
    const sqls = fixture.calls.map(({ sql }) => sql)
    expect(sqls).toContain("ROLLBACK")
    expect(sqls).not.toContain("COMMIT")
    expect(fixture.client.release).toHaveBeenCalledOnce()
  })
})
