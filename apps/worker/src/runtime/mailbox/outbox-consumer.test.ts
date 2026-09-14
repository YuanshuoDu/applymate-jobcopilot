import type pg from "pg"
import { describe, expect, it, vi } from "vitest"

import { drainSubagentMailboxOutbox, startSubagentMailboxOutboxConsumer } from "./outbox-consumer.js"

type OutboxRow = {
  id: string
  aggregateId: string
  payload: unknown
  createdAt: Date
  publishedAt: Date | null
  attemptCount: number
  lastError: string | null
}
type MailboxRow = {
  id: string
  sessionId: string
  turnId: string
  toTaskId: string
  deliveredAt: Date | null
  consumedAt: Date | null
}
type FakeOptions = {
  outbox?: Partial<OutboxRow>
  payload?: unknown
  sessionStatus?: string
  lineageValid?: boolean
  failOn?: string
}

const validPayload = { messageId: "message-1", sessionId: "session-1", turnId: "turn-1", toTaskId: "task-1" }

function makeOutbox(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "outbox-1", aggregateId: "session-1", payload: validPayload,
    createdAt: new Date("2026-09-14T10:00:00.000Z"), publishedAt: null, attemptCount: 0, lastError: null, ...overrides,
  }
}

function makeMailbox(overrides: Partial<MailboxRow> = {}): MailboxRow {
  return {
    id: "message-1", sessionId: "session-1", turnId: "turn-1", toTaskId: "task-1",
    deliveredAt: null, consumedAt: null, ...overrides,
  }
}

class FakeClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  readonly outboxRows: OutboxRow[]
  readonly mailboxRows: MailboxRow[]
  private rollbackState: { outbox: OutboxRow[]; mailbox: MailboxRow[] } | null = null

  constructor(private readonly options: FakeOptions = {}, outboxRows: readonly OutboxRow[] = [makeOutbox()]) {
    this.outboxRows = outboxRows.map(row => ({ ...row, ...this.options.outbox, ...(this.options.payload === undefined ? {} : { payload: this.options.payload }) }))
    this.mailboxRows = [makeMailbox()]
  }

  async query<T = Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, values })
    if (this.options.failOn && sql.includes(this.options.failOn)) throw new Error("database unavailable")
    if (sql === "BEGIN") {
      this.rollbackState = { outbox: this.outboxRows.map(row => ({ ...row })), mailbox: this.mailboxRows.map(row => ({ ...row })) }
      return { rows: [], rowCount: 0 }
    }
    if (sql === "COMMIT") { this.rollbackState = null; return { rows: [], rowCount: 0 } }
    if (sql === "ROLLBACK") {
      if (this.rollbackState) {
        this.outboxRows.splice(0, this.outboxRows.length, ...this.rollbackState.outbox.map(row => ({ ...row })))
        this.mailboxRows.splice(0, this.mailboxRows.length, ...this.rollbackState.mailbox.map(row => ({ ...row })))
      }
      this.rollbackState = null
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM "agent_outbox"') && sql.includes('"publishedAt" IS NULL')) {
      const limit = Number(values[1])
      const rows = this.outboxRows
        .filter(row => row.publishedAt === null)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
        .slice(0, limit)
      return { rows: rows as T[], rowCount: rows.length }
    }
    if (sql.startsWith('UPDATE "agent_outbox"')) {
      const row = this.outboxRows.find(candidate => candidate.id === String(values[0]) && candidate.publishedAt === null)
      if (row) {
        row.publishedAt = new Date("2026-09-14T10:01:00.000Z")
        row.attemptCount += 1
        row.lastError = values[1] == null ? null : String(values[1])
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
      return this.options.sessionStatus === "aborted" || this.options.sessionStatus === "archived"
        ? { rows: [], rowCount: 0 } : { rows: [{ id: "session-1", userId: "user-1" } as T], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_mailbox_messages"') && sql.includes("FOR UPDATE OF")) {
      if (this.options.lineageValid === false) return { rows: [], rowCount: 0 }
      const row = this.mailboxRows[0]
      return row ? { rows: [{ id: row.id, deliveredAt: row.deliveredAt } as T], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('UPDATE "agent_mailbox_messages"')) {
      const row = this.mailboxRows.find(candidate => candidate.id === String(values[0]) && candidate.deliveredAt === null)
      if (row) row.deliveredAt = new Date("2026-09-14T10:01:00.000Z")
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes("set_config('app.user_id'")) return { rows: [], rowCount: 1 }
    throw new Error(`Unexpected query: ${sql}`)
  }

  release(): void {}
}

function fakePool(options: FakeOptions = {}, rows?: readonly OutboxRow[]) {
  const client = new FakeClient(options, rows)
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { client, pool }
}

describe("subagent mailbox outbox consumer", () => {
  it("delivers valid rows with stable bounded selection and lineage locks", async () => {
    const older = makeOutbox({ id: "outbox-0", createdAt: new Date("2026-09-14T09:00:00.000Z") })
    const fake = fakePool({}, [older, makeOutbox()])

    await expect(drainSubagentMailboxOutbox(fake.pool, 99)).resolves.toBe(2)

    expect(fake.client.outboxRows.every(row => row.publishedAt !== null && row.attemptCount === 1 && row.lastError === null)).toBe(true)
    expect(fake.client.mailboxRows[0]?.deliveredAt).not.toBeNull()
    const scan = fake.client.calls.find(call => call.sql.includes('FROM "agent_outbox"') && call.sql.includes('"publishedAt" IS NULL'))
    expect(scan?.sql).toContain('WHERE "topic" = $1 AND "publishedAt" IS NULL')
    expect(scan?.sql).toContain('ORDER BY "createdAt" ASC, "id" ASC')
    expect(scan?.sql).toContain("LIMIT $2 FOR UPDATE SKIP LOCKED")
    expect(scan?.values).toEqual(["agent.subagent.mailbox", 50])
    const message = fake.client.calls.find(call => call.sql.includes('FROM "agent_mailbox_messages"'))
    expect(message?.sql).toContain('message."sessionId" = $2 AND message."turnId" = $3')
    expect(message?.sql).toContain('target."turnId" = $3')
    expect(message?.sql).toContain('turn."id" = $3 AND turn."sessionId" = $2')
    expect(message?.sql).toContain("FOR UPDATE OF message, target, turn")
    const tenant = fake.client.calls.find(call => call.sql.includes("set_config('app.user_id'"))
    expect(tenant?.values).toEqual(["user-1"])
    expect(fake.client.calls.indexOf(tenant!)).toBeGreaterThan(fake.client.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"') && call.sql.includes("FOR UPDATE")))
    expect(fake.client.calls.indexOf(tenant!)).toBeLessThan(fake.client.calls.indexOf(message!))
  })

  it("does not write deliveredAt again when a valid row was already delivered", async () => {
    const deliveredAt = new Date("2026-09-14T09:59:00.000Z")
    const fake = fakePool({}, [makeOutbox()])
    fake.client.mailboxRows[0]!.deliveredAt = deliveredAt

    await expect(drainSubagentMailboxOutbox(fake.pool)).resolves.toBe(1)

    expect(fake.client.mailboxRows[0]?.deliveredAt).toBe(deliveredAt)
    expect(fake.client.calls.filter(call => call.sql.startsWith('UPDATE "agent_mailbox_messages"'))).toHaveLength(0)
    expect(fake.client.outboxRows[0]).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, lastError: null })
  })

  it.each([
    ["malformed payload", { payload: { messageId: "message-1", sessionId: "session-1", turnId: "turn-1", toTaskId: "task-1", extra: true } }, "schema_invalid_payload"],
    ["aggregate mismatch", { outbox: { aggregateId: "other-session" } }, "mailbox_outbox_aggregate_mismatch"],
    ["missing message", { lineageValid: false }, "mailbox_lineage_mismatch"],
    ["cross-lineage message", { lineageValid: false, payload: { ...validPayload, turnId: "turn-old" } }, "mailbox_lineage_mismatch"],
    ["closed session", { sessionStatus: "archived" }, "mailbox_session_unavailable"],
  ] as const)("terminally records %s without mutating mailbox or task state", async (_label, options, errorCode) => {
    const fake = fakePool(options)
    const beforeMailbox = { ...fake.client.mailboxRows[0] }

    await expect(drainSubagentMailboxOutbox(fake.pool)).resolves.toBe(1)

    expect(fake.client.outboxRows[0]).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, lastError: errorCode })
    expect(fake.client.mailboxRows[0]).toEqual(beforeMailbox)
    expect(fake.client.calls.some(call => call.sql.startsWith('UPDATE "agent_mailbox_messages"'))).toBe(false)
    expect(fake.client.calls.some(call => call.sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("rolls back delivery and leaves the outbox pending after a database failure", async () => {
    const fake = fakePool({ failOn: 'UPDATE "agent_outbox"' })

    await expect(drainSubagentMailboxOutbox(fake.pool)).rejects.toThrow("database unavailable")

    expect(fake.client.outboxRows[0]).toMatchObject({ publishedAt: null, attemptCount: 0, lastError: null })
    expect(fake.client.mailboxRows[0]).toMatchObject({ deliveredAt: null, consumedAt: null })
    expect(fake.client.calls.map(call => call.sql)).toContain("ROLLBACK")
  })

  it("rejects an invalid batch before touching the pool and clamps oversized batches", async () => {
    const fake = fakePool()

    await expect(drainSubagentMailboxOutbox(fake.pool, 0)).rejects.toThrow("batch size must be positive")
    expect(fake.pool.connect).not.toHaveBeenCalled()
    await expect(drainSubagentMailboxOutbox(fake.pool, 500)).resolves.toBe(1)
    const scan = fake.client.calls.find(call => call.sql.includes('FROM "agent_outbox"'))
    expect(scan?.values?.[1]).toBe(50)
  })

  it("allows an injected drain in the polling wrapper and closes without a duplicate loop", async () => {
    const drain = vi.fn(async () => 0)
    const fake = fakePool()
    const consumer = startSubagentMailboxOutboxConsumer(fake.pool, { pollMs: 30_000, drain })

    expect(drain).toHaveBeenCalledOnce()
    await consumer.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(drain).toHaveBeenCalledOnce()
  })
})
