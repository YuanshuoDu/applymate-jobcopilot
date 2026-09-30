import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgInterruptPersistence, InterruptPersistenceError, InMemoryInterruptPersistence } from "./persistence.js"

type QueryResult<T> = { rows: T[]; rowCount: number | null }
type EventRecord = { type: string; createdAt?: Date | string; idempotencyKey?: string }
type FakeOptions = { sessionStatus?: string; sessionVisible?: boolean; sessionUserId?: string; turnVisible?: boolean; turnStatus?: string; events?: EventRecord[] }

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }
const requestedAt = new Date("2026-09-02T10:00:00.000Z")

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
      const key = values?.[2]
      const existing = sql.includes('"idempotencyKey" = $3')
        ? this.events.find(event => event.idempotencyKey === key || event.type === "turn.interrupted")
        : this.events.find(event => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))
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
      const eventType = sql.includes("'turn.interrupt.requested'") ? "turn.interrupt.requested" : "turn.interrupted"
      this.events.push({ type: eventType, idempotencyKey: String(values?.[4]) })
      return { rows: [], rowCount: 1 } as QueryResult<T>
    }
    return { rows: [], rowCount: 1 } as QueryResult<T>
  }

  release(): void { this.released = true }
}

function poolFor(client: FakeClient): Pick<pg.Pool, "connect"> {
  return { connect: vi.fn(async () => client.client) }
}

describe("interrupt persistence port", () => {
  it("is durable and idempotent for concurrent Stop requests", async () => {
    const persistence = new InMemoryInterruptPersistence()
    const [first, second] = await Promise.all([
      persistence.persist({ ...target, requestId: "stop-1", requestedAt, reason: "user_stop" }),
      persistence.persist({ ...target, requestId: "stop-2", requestedAt, reason: "duplicate_stop" }),
    ])
    expect([first.disposition, second.disposition].sort()).toEqual(["accepted", "duplicate"])
    expect(first.persistedAt).toEqual(requestedAt)
    expect(second.requestId).toBe("stop-2")
    const lookupTarget = { ...target, payload: { source: "control-plane" } }
    await expect(persistence.isRequested(lookupTarget)).resolves.toBe(true)
  })

  it("locks the session before the Turn and writes one event with its outbox", async () => {
    const client = new FakeClient()
    const persistence = createPgInterruptPersistence(poolFor(client), () => requestedAt)

    await expect(persistence.persist({ ...target, requestId: "stop-1", requestedAt })).resolves.toMatchObject({ disposition: "accepted", persistedAt: requestedAt })
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
    expect(client.calls).toContainEqual({ sql: "COMMIT", values: undefined })
  })

  it.each(["running", "paused", "waiting_for_user"])("preserves interrupt writes for a %s session", async sessionStatus => {
    const client = new FakeClient({ sessionStatus })
    const persistence = createPgInterruptPersistence(poolFor(client), () => requestedAt)
    await expect(persistence.persist({ ...target, requestId: `stop-${sessionStatus}` })).resolves.toMatchObject({ disposition: "accepted" })
    expect(client.calls.some(call => call.sql.startsWith('INSERT INTO "agent_events"'))).toBe(true)
  })

  it.each(["aborted", "archived"])("rejects a closed %s session before any new writes", async sessionStatus => {
    const client = new FakeClient({ sessionStatus })
    const persistence = createPgInterruptPersistence(poolFor(client))

    await expect(persistence.persist({ ...target, requestId: "stop-closed" })).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(client.calls.some(call => call.sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith('UPDATE "agent_sessions"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
  })

  it.each([
    ["missing", { sessionVisible: false }],
    ["cross-user", { sessionUserId: "user-2" }],
  ] as const)("rejects a %s session before the Turn lock or writes", async (_label, options) => {
    const client = new FakeClient(options)
    const persistence = createPgInterruptPersistence(poolFor(client))

    await expect(persistence.persist({ ...target, requestId: "stop-invalid-session" })).rejects.toMatchObject({ code: "persistence_conflict" })
    expect(client.calls.some(call => call.sql.includes('FROM "agent_turns"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
  })

  it("rejects a missing or cross-user Turn after locking the session", async () => {
    const client = new FakeClient({ turnVisible: false })
    const persistence = createPgInterruptPersistence(poolFor(client))

    await expect(persistence.persist({ ...target, requestId: "stop-invalid-turn" })).rejects.toMatchObject({ code: "turn_not_found" })
    const sessionLock = client.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"'))
    const turnLock = client.calls.findIndex(call => call.sql.includes('FROM "agent_turns"'))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(client.calls.some(call => call.sql.includes('FROM "agent_events"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
  })

  it("keeps closed-session duplicate requests idempotent", async () => {
    const createdAt = new Date("2026-09-02T09:59:00.000Z")
    const client = new FakeClient({ sessionStatus: "aborted", turnStatus: "in_progress", events: [{ type: "turn.interrupted", createdAt }] })
    const persistence = createPgInterruptPersistence(poolFor(client), () => requestedAt)

    await expect(persistence.persist({ ...target, requestId: "stop-duplicate" })).resolves.toMatchObject({ disposition: "duplicate", persistedAt: createdAt })
    expect(client.calls.some(call => call.sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
    expect(client.calls).toContainEqual({ sql: "COMMIT", values: undefined })
  })

  it("treats an interrupted Turn as a duplicate after session closure", async () => {
    const client = new FakeClient({ sessionStatus: "archived", turnStatus: "interrupted" })
    const persistence = createPgInterruptPersistence(poolFor(client))

    await expect(persistence.persist({ ...target, requestId: "stop-interrupted" })).resolves.toMatchObject({ disposition: "duplicate" })
    expect(client.calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false)
  })

  it("rolls back and restores state when a later durable write fails", async () => {
    const client = new FakeClient()
    client.failOn = 'INSERT INTO "agent_outbox"'
    const persistence = createPgInterruptPersistence(poolFor(client))

    await expect(persistence.persist({ ...target, requestId: "stop-failure" })).rejects.toThrow("query failure")
    expect(client.turnStatus).toBe("in_progress")
    expect(client.eventSequence).toBe(10n)
    expect(client.events).toHaveLength(0)
    expect(client.calls).toContainEqual({ sql: "ROLLBACK", values: undefined })
    expect(client.released).toBe(true)
  })

  it("exposes the typed error class for durable conflicts", () => {
    expect(new InterruptPersistenceError("persistence_conflict", "closed")).toBeInstanceOf(Error)
  })
})
