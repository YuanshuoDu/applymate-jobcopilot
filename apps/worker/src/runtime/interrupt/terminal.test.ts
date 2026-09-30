import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgTerminalEventPort, InMemoryTerminalEventPort, TerminalEventConflictError } from "./terminal.js"

type QueryResult<T> = { rows: T[]; rowCount: number | null }
type EventRecord = { type: string }
type FakeOptions = { sessionStatus?: string; sessionVisible?: boolean; sessionUserId?: string; turnVisible?: boolean; turnStatus?: string; events?: EventRecord[] }

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }

class FakeClient {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  readonly client: pg.PoolClient
  sessionStatus: string
  readonly sessionVisible: boolean
  readonly sessionUserId: string
  turnVisible: boolean
  turnStatus: string
  eventSequence = 10n
  events: EventRecord[]
  failOn: string | null = null
  released = false
  private snapshot: { turnStatus: string; eventSequence: bigint; events: EventRecord[] } | null = null

  constructor(options: FakeOptions = {}) {
    this.sessionStatus = options.sessionStatus ?? "running"
    this.sessionVisible = options.sessionVisible ?? true
    this.sessionUserId = options.sessionUserId ?? target.userId
    this.turnVisible = options.turnVisible ?? true
    this.turnStatus = options.turnStatus ?? "in_progress"
    this.events = [...(options.events ?? [])]
    this.client = this as unknown as pg.PoolClient
  }

  async query<T>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push({ sql, values })
    if (this.failOn && sql.includes(this.failOn)) throw new Error("query failure")
    if (sql === "BEGIN") {
      this.snapshot = { turnStatus: this.turnStatus, eventSequence: this.eventSequence, events: [...this.events] }
      return { rows: [], rowCount: 0 } as QueryResult<T>
    }
    if (sql === "ROLLBACK") {
      if (this.snapshot) {
        this.turnStatus = this.snapshot.turnStatus
        this.eventSequence = this.snapshot.eventSequence
        this.events = [...this.snapshot.events]
      }
      return { rows: [], rowCount: 0 } as QueryResult<T>
    }
    if (sql === "COMMIT" || sql.includes("set_config")) return { rows: [], rowCount: 0 } as QueryResult<T>
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
      const matched = this.sessionVisible && values?.[0] === target.sessionId && values?.[1] === this.sessionUserId
      return { rows: matched ? [{ status: this.sessionStatus } as T] : [], rowCount: matched ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) {
      const matched = this.turnVisible && values?.[0] === target.turnId && values?.[1] === target.sessionId && values?.[2] === target.userId
      return { rows: matched ? [{ status: this.turnStatus } as T] : [], rowCount: matched ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_events"')) {
      const existing = this.events.find(event => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))
      return { rows: existing ? [existing as T] : [], rowCount: existing ? 1 : 0 }
    }
    if (sql.startsWith('UPDATE "agent_turns"')) {
      this.turnStatus = "interrupted"
      return { rows: [], rowCount: 1 } as QueryResult<T>
    }
    if (sql.startsWith('UPDATE "agent_sessions"')) {
      this.eventSequence += 1n
      return { rows: [{ eventSequence: this.eventSequence } as T], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO "agent_events"')) {
      this.events.push({ type: "turn.interrupted" })
      return { rows: [], rowCount: 1 } as QueryResult<T>
    }
    return { rows: [], rowCount: 1 } as QueryResult<T>
  }

  release(): void { this.released = true }
}

function poolFor(client: FakeClient): Pick<pg.Pool, "connect"> {
  return { connect: vi.fn(async () => client.client) }
}

const input = { ...target, requestId: "stop-1", reason: "user_stop", payload: { source: "control-plane" } }

describe("terminal event port", () => {
  it("appends one terminal event for concurrent Stop calls and keeps payload metadata", async () => {
    const terminal = new InMemoryTerminalEventPort()
    const [first, second] = await Promise.all([
      terminal.append({ ...target, requestId: "stop-1", reason: "user_stop", payload: { operationCount: 2 } }),
      terminal.append({ ...target, requestId: "stop-2", reason: "duplicate_stop", payload: ["metadata"] }),
    ])
    expect([first, second].sort()).toEqual(["appended", "duplicate"])
    const lookupTarget = { ...target, payload: { lookup: true } }
    expect(terminal.events(lookupTarget)).toHaveLength(1)
    expect(terminal.events()[0].payload).toEqual({ operationCount: 2 })
  })

  it("locks the session before the Turn and persists the terminal event and outbox", async () => {
    const client = new FakeClient()
    const terminal = createPgTerminalEventPort(poolFor(client), () => new Date("2026-09-02T10:00:00.000Z"))

    await expect(terminal.append(input)).resolves.toBe("appended")
    const sessionLock = client.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"') && call.sql.includes("FOR UPDATE"))
    const turnLock = client.calls.findIndex(call => call.sql.includes('FROM "agent_turns"') && call.sql.includes("FOR UPDATE"))
    const eventRead = client.calls.findIndex(call => call.sql.includes('FROM "agent_events"'))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(turnLock).toBeLessThan(eventRead)
    expect(client.calls.some(call => call.sql.startsWith('UPDATE "agent_turns"'))).toBe(true)
    expect(client.calls.some(call => call.sql.startsWith('UPDATE "agent_sessions"'))).toBe(true)
    expect(client.calls.some(call => call.sql.startsWith('INSERT INTO "agent_events"'))).toBe(true)
    expect(client.calls.some(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(true)
  })

  it("appends an event for an already interrupted Turn when the event is missing", async () => {
    const client = new FakeClient({ turnStatus: "interrupted" })
    const terminal = createPgTerminalEventPort(poolFor(client))

    await expect(terminal.append(input)).resolves.toBe("appended")
    expect(client.calls.some(call => call.sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    expect(client.events).toEqual([{ type: "turn.interrupted" }])
  })

  it.each(["aborted", "archived"])("rejects a closed %s session without a terminal interrupt event", async sessionStatus => {
    const client = new FakeClient({ sessionStatus })
    const terminal = createPgTerminalEventPort(poolFor(client))

    await expect(terminal.append(input)).rejects.toBeInstanceOf(TerminalEventConflictError)
    expect(client.calls.some(call => call.sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith('UPDATE "agent_sessions"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
  })

  it("returns duplicate for an existing interrupted terminal event in a closed session", async () => {
    const client = new FakeClient({ sessionStatus: "archived", events: [{ type: "turn.interrupted" }] })
    const terminal = createPgTerminalEventPort(poolFor(client))

    await expect(terminal.append(input)).resolves.toBe("duplicate")
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "COMMIT", values: undefined })
  })

  it.each([
    ["missing", { sessionVisible: false }],
    ["cross-user", { sessionUserId: "user-2" }],
  ] as const)("rejects a %s session before the Turn lock or writes", async (_label, options) => {
    const client = new FakeClient(options)
    const terminal = createPgTerminalEventPort(poolFor(client))

    await expect(terminal.append(input)).rejects.toBeInstanceOf(TerminalEventConflictError)
    expect(client.calls.some(call => call.sql.includes('FROM "agent_turns"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
  })

  it("rejects a missing or cross-user Turn after locking the session", async () => {
    const client = new FakeClient({ turnVisible: false })
    const terminal = createPgTerminalEventPort(poolFor(client))

    await expect(terminal.append(input)).rejects.toBeInstanceOf(TerminalEventConflictError)
    const sessionLock = client.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"'))
    const turnLock = client.calls.findIndex(call => call.sql.includes('FROM "agent_turns"'))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(client.calls.some(call => call.sql.includes('FROM "agent_events"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
  })

  it.each(["turn.completed", "turn.failed"])("preserves %s terminal conflict semantics", async eventType => {
    const client = new FakeClient({ events: [{ type: eventType }] })
    const terminal = createPgTerminalEventPort(poolFor(client))

    await expect(terminal.append(input)).rejects.toThrow(`Turn already has terminal event ${eventType}`)
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
  })

  it("rolls back and restores state when a later durable write fails", async () => {
    const client = new FakeClient()
    client.failOn = 'INSERT INTO "agent_outbox"'
    const terminal = createPgTerminalEventPort(poolFor(client))

    await expect(terminal.append(input)).rejects.toThrow("query failure")
    expect(client.turnStatus).toBe("in_progress")
    expect(client.eventSequence).toBe(10n)
    expect(client.events).toHaveLength(0)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
    expect(client.released).toBe(true)
  })
})
