import type pg from "pg"
import { describe, expect, it } from "vitest"

import { PgCoordinationStore } from "./store.js"
import type { CoordinationMailboxMessage, CoordinationTaskView } from "../tools/coordination-types.js"

type QueryRecord = { sql: string; values: readonly unknown[] }
type MailboxRow = { -readonly [Key in keyof CoordinationMailboxMessage]: CoordinationMailboxMessage[Key] }

const task: CoordinationTaskView = {
  id: "task-1", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "task-1", parentTaskId: null,
  path: "/task-1", depth: 0, role: "scout", taskType: "inspect", status: "queued", goal: "Inspect",
  attemptCount: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
}

function mailboxRow(overrides: Partial<MailboxRow> = {}): MailboxRow {
  return {
    id: "message-1", sessionId: "session-a", turnId: "turn-a", fromTaskId: "task-sender", toTaskId: "task-1",
    kind: "result", payload: { ok: true }, idempotencyKey: "message-key-1",
    createdAt: new Date("2026-09-03T00:00:00.000Z"), deliveredAt: null, consumedAt: null, ...overrides,
  }
}

class FakeClient {
  readonly queries: QueryRecord[] = []
  private readonly rows: Record<string, unknown>
  readonly mailboxRows: MailboxRow[]

  constructor(
    private readonly mode: "task" | "empty" = "task",
    private readonly sessionStatus = "running",
    mailboxRows: readonly MailboxRow[] = [],
    private readonly sessionUser = "user-a",
  ) {
    this.rows = { ...task, createdAt: new Date("2026-09-03T00:00:00.000Z") }
    this.mailboxRows = mailboxRows.map(row => ({ ...row }))
  }

  async query(sql: unknown, values: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const text = String(sql)
    this.queries.push({ sql: text, values })
    if (text.includes("FROM \"sub_agent_tasks\" task") && text.includes("SELECT")) return { rows: this.mode === "task" ? [this.rows] : [], rowCount: this.mode === "task" ? 1 : 0 }
    if (text.includes('FROM "agent_sessions"') && text.includes("FOR UPDATE") && text.includes('"status" NOT IN')) {
      return ["aborted", "archived"].includes(this.sessionStatus) || String(values[1]) !== this.sessionUser ? { rows: [], rowCount: 0 } : { rows: [{ id: "ok" }], rowCount: 1 }
    }
    if (text.includes('UPDATE "agent_mailbox_messages"')) {
      const sessionId = String(values[0])
      const toTaskId = String(values[2])
      const requested = Array.isArray(values[3]) ? values[3].map(value => String(value)) : []
      const confirmed = this.mailboxRows.filter(row => row.sessionId === sessionId && row.toTaskId === toTaskId && row.consumedAt === null && requested.includes(row.id))
      for (const row of confirmed) row.consumedAt = new Date("2026-09-03T00:02:00.000Z")
      return { rows: confirmed.map(row => ({ id: row.id })), rowCount: confirmed.length }
    }
    if (text.includes('FROM "agent_mailbox_messages"') && text.includes("SELECT")) {
      const sessionId = String(values[0])
      const toTaskId = String(values[2])
      const limit = Number(values[3])
      const pending = this.mailboxRows
        .filter(row => row.sessionId === sessionId && row.toTaskId === toTaskId && row.consumedAt === null)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
        .slice(0, limit)
      return { rows: pending.map(row => ({ ...row })), rowCount: pending.length }
    }
    if (text.includes("FROM \"agent_sessions\"") || text.includes("FROM \"agent_turns\"") || text.includes("FROM \"sub_agent_tasks\"")) return { rows: [{ id: "ok" }], rowCount: 1 }
    if (text.includes("FROM \"agent_mailbox_messages\"")) return { rows: [], rowCount: 0 }
    if (text.includes("INSERT INTO \"agent_mailbox_messages\"")) return { rows: [{ id: "mailbox-1", sessionId: "session-a", turnId: "turn-a", fromTaskId: null, toTaskId: "task-1", kind: "result", idempotencyKey: "message-1", createdAt: new Date("2026-09-03T00:00:00.000Z") }], rowCount: 1 }
    if (text.includes("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: 1n }], rowCount: 1 }
    if (text.includes("SELECT 1 FROM \"agent_events\"")) return { rows: [], rowCount: 0 }
    if (text.includes("INSERT INTO \"agent_outbox\"")) return { rows: [], rowCount: 1 }
    if (text.includes("INSERT INTO \"agent_items\"") || text.includes("INSERT INTO \"agent_events\"")) return { rows: [], rowCount: 1 }
    if (text.includes("SELECT set_config")) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }

  release(): void {}
}

function pool(client: FakeClient): Pick<pg.Pool, "connect"> {
  return { connect: async () => client as unknown as pg.PoolClient }
}

describe("PgCoordinationStore", () => {
  it("fences task reads by runtime user and session without leaking foreign existence", async () => {
    const client = new FakeClient("empty")
    const store = new PgCoordinationStore(pool(client))
    await expect(store.getTask({ userId: "user-b", sessionId: "session-b", taskId: "task-1" })).resolves.toBeNull()
    const read = client.queries.find(query => query.sql.includes("FROM \"sub_agent_tasks\" task"))
    expect(read?.values).toEqual(["task-1", "session-b", "user-b"])
    expect(client.queries.some(query => query.sql.includes("set_config('app.user_id'"))).toBe(true)
  })

  it("lists pending mailbox payloads in stable order and clamps the read limit", async () => {
    const sameTime = new Date("2026-09-03T00:01:00.000Z")
    const deliveredAt = new Date("2026-09-03T00:01:30.000Z")
    const client = new FakeClient("task", "running", [
      mailboxRow({ id: "message-z", createdAt: sameTime, payload: { order: "z" } }),
      mailboxRow({ id: "message-a", createdAt: sameTime, payload: { order: "a" }, deliveredAt }),
      mailboxRow({ id: "message-old", createdAt: new Date("2026-09-03T00:00:00.000Z"), payload: { order: "old" } }),
      mailboxRow({ id: "message-consumed", consumedAt: new Date("2026-09-03T00:02:00.000Z") }),
      mailboxRow({ id: "message-foreign", sessionId: "session-b", toTaskId: "task-foreign" }),
    ])
    const store = new PgCoordinationStore(pool(client))

    await expect(store.listPendingMessages({ userId: "user-a", sessionId: "session-a", toTaskId: "task-1", limit: 10_000 }))
      .resolves.toMatchObject([
        { id: "message-old", payload: { order: "old" }, deliveredAt: null, consumedAt: null },
        { id: "message-a", payload: { order: "a" }, deliveredAt, consumedAt: null },
        { id: "message-z", payload: { order: "z" }, deliveredAt: null, consumedAt: null },
      ])
    const read = client.queries.find(query => query.sql.includes('FROM "agent_mailbox_messages"') && query.sql.includes("ORDER BY"))
    expect(read?.sql).toContain('message."consumedAt" IS NULL')
    expect(read?.sql).toContain('ORDER BY message."createdAt" ASC, message."id" ASC')
    expect(read?.values).toEqual(["session-a", "user-a", "task-1", 100])
  })

  it("fails closed for foreign and closed mailbox read scopes", async () => {
    const foreignClient = new FakeClient("task", "running", [], "user-a")
    const foreignStore = new PgCoordinationStore(pool(foreignClient))
    await expect(foreignStore.listPendingMessages({ userId: "user-b", sessionId: "session-a", toTaskId: "task-1" }))
      .rejects.toMatchObject({ code: "coordination_scope_error" })
    expect(foreignClient.queries.some(query => query.sql.includes('FROM "agent_mailbox_messages"'))).toBe(false)

    const closedClient = new FakeClient("task", "archived", [mailboxRow()])
    const closedStore = new PgCoordinationStore(pool(closedClient))
    await expect(closedStore.listPendingMessages({ userId: "user-a", sessionId: "session-a", toTaskId: "task-1" }))
      .rejects.toMatchObject({ code: "coordination_scope_error" })
    expect(closedClient.queries.some(query => query.sql.includes('FROM "agent_mailbox_messages"'))).toBe(false)
  })

  it("consumes only selected pending rows and makes repeated consume idempotent", async () => {
    const selected = mailboxRow({ id: "message-selected" })
    const second = mailboxRow({ id: "message-second" })
    const alreadyConsumed = mailboxRow({ id: "message-consumed", consumedAt: new Date("2026-09-03T00:02:00.000Z") })
    const otherTask = mailboxRow({ id: "message-other-task", toTaskId: "task-2" })
    const foreign = mailboxRow({ id: "message-foreign", sessionId: "session-b" })
    const client = new FakeClient("task", "running", [selected, second, alreadyConsumed, otherTask, foreign])
    const store = new PgCoordinationStore(pool(client))

    const first = await store.consumeMessages({ userId: "user-a", sessionId: "session-a", toTaskId: "task-1", messageIds: [second.id, "missing", selected.id, second.id] })
    expect(first).toEqual({ messageIds: [second.id, selected.id], count: 2 })
    expect(client.mailboxRows.find(row => row.id === selected.id)?.consumedAt).toEqual(new Date("2026-09-03T00:02:00.000Z"))
    expect(client.mailboxRows.find(row => row.id === alreadyConsumed.id)?.consumedAt).toEqual(alreadyConsumed.consumedAt)
    expect(client.mailboxRows.find(row => row.id === otherTask.id)?.consumedAt).toBeNull()
    expect(client.mailboxRows.find(row => row.id === foreign.id)?.consumedAt).toBeNull()

    const update = client.queries.find(query => query.sql.includes('UPDATE "agent_mailbox_messages"'))
    expect(update?.sql).toContain('message."consumedAt" IS NULL')
    expect(update?.sql).not.toContain('deliveredAt')
    expect(update?.values).toEqual(["session-a", "user-a", "task-1", [second.id, "missing", selected.id]])

    const secondConsume = await store.consumeMessages({ userId: "user-a", sessionId: "session-a", toTaskId: "task-1", messageIds: [second.id, selected.id] })
    expect(secondConsume).toEqual({ messageIds: [], count: 0 })
    expect(client.queries.filter(query => query.sql.includes('UPDATE "agent_mailbox_messages"'))).toHaveLength(2)
  })

  it.each(["aborted", "archived"] as const)("rejects consume for a %s session before any mailbox update", async sessionStatus => {
    const client = new FakeClient("task", sessionStatus, [mailboxRow()])
    const store = new PgCoordinationStore(pool(client))

    await expect(store.consumeMessages({ userId: "user-a", sessionId: "session-a", toTaskId: "task-1", messageIds: ["message-1"] }))
      .rejects.toMatchObject({ code: "coordination_scope_error" })
    expect(client.queries.some(query => query.sql.includes('UPDATE "agent_mailbox_messages"'))).toBe(false)
    expect(client.mailboxRows[0]?.consumedAt).toBeNull()
  })

  it("writes mailbox message and outbox notification in one tenant-scoped transaction", async () => {
    const client = new FakeClient()
    const store = new PgCoordinationStore(pool(client))
    const result = await store.sendMessage({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", fromTaskId: null, toTaskId: "task-1", kind: "result", payload: { ok: true }, idempotencyKey: "message-1" })
    expect(result).toMatchObject({ duplicate: false, message: { idempotencyKey: "message-1", toTaskId: "task-1" } })
    const sql = client.queries.map(query => query.sql).join("\n")
    expect(sql).toMatch(/BEGIN[\s\S]*INSERT INTO "agent_mailbox_messages"[\s\S]*agent\.subagent\.mailbox[\s\S]*COMMIT/)
    expect(client.queries.find(query => query.sql.includes("set_config('app.user_id'"))?.values).toContain("user-a")
    const sessionGuard = client.queries.find(query => query.sql.includes('FROM "agent_sessions"') && query.sql.includes("FOR UPDATE"))?.sql ?? ""
    expect(sessionGuard).toContain('"status" NOT IN (\'aborted\', \'archived\')')
  })

  it.each(["aborted", "archived"] as const)("rejects sendMessage for a %s session before any write", async sessionStatus => {
    const client = new FakeClient("task", sessionStatus)
    const store = new PgCoordinationStore(pool(client))

    await expect(store.sendMessage({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", fromTaskId: null, toTaskId: "task-1", kind: "result", payload: { ok: true }, idempotencyKey: "message-closed" }))
      .rejects.toMatchObject({ code: "coordination_scope_error" })
    expect(client.queries.some(query => query.sql.includes("INSERT INTO") || query.sql.includes("UPDATE "))).toBe(false)
    expect(client.queries.map(query => query.sql)).toContain("ROLLBACK")
  })

  it("atomically records spawn replay and deterministic dispatch outbox entries", async () => {
    const client = new FakeClient()
    const store = new PgCoordinationStore(pool(client))
    await expect(store.recordSpawn({ userId: "user-a", sessionId: "session-a", idempotencyKey: "spawn-1", task })).resolves.toBe(true)
    const inserts = client.queries.filter(query => query.sql.includes("INSERT INTO \"agent_outbox\""))
    expect(inserts).toHaveLength(2)
    expect(inserts.some(query => query.sql.includes("'agent.subagent.spawn'") && query.values.includes("coordination-spawn:session-a:spawn-1"))).toBe(true)
    expect(inserts.some(query => query.sql.includes("'agent.subagent.dispatch'") && query.values.includes("subagent-dispatch:task-1"))).toBe(true)
    expect(client.queries.map(query => query.sql)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]))
  })

  it.each(["aborted", "archived"] as const)("rejects recordSpawn for a %s session before any write", async sessionStatus => {
    const client = new FakeClient("task", sessionStatus)
    const store = new PgCoordinationStore(pool(client))

    await expect(store.recordSpawn({ userId: "user-a", sessionId: "session-a", idempotencyKey: "spawn-closed", task }))
      .rejects.toMatchObject({ code: "coordination_scope_error" })
    expect(client.queries.some(query => query.sql.includes("INSERT INTO") || query.sql.includes("UPDATE "))).toBe(false)
    expect(client.queries.map(query => query.sql)).toContain("ROLLBACK")
  })

  it("projects coordination activity as an item, event, and session outbox notification", async () => {
    const client = new FakeClient()
    const store = new PgCoordinationStore(pool(client))
    await store.appendActivity({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", stepId: "step-a", taskId: "task-1", operation: "list_subagents", status: "completed", idempotencyKey: "call-1:list", data: { count: 1 } })
    const sql = client.queries.map(query => query.sql).join("\n")
    expect(sql).toMatch(/INSERT INTO "agent_items"[\s\S]*INSERT INTO "agent_events"[\s\S]*agent\.session\.event/)
    expect(client.queries.some(query => query.sql.includes("UPDATE \"agent_sessions\" SET \"eventSequence\""))).toBe(true)
  })

  it.each(["aborted", "archived"] as const)("rejects appendActivity for a %s session before any write", async sessionStatus => {
    const client = new FakeClient("task", sessionStatus)
    const store = new PgCoordinationStore(pool(client))

    await expect(store.appendActivity({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", stepId: "step-a", taskId: "task-1", operation: "list_subagents", status: "completed", idempotencyKey: "activity-closed", data: { count: 1 } }))
      .rejects.toMatchObject({ code: "coordination_scope_error" })
    expect(client.queries.some(query => query.sql.includes("INSERT INTO") || query.sql.includes("UPDATE "))).toBe(false)
    expect(client.queries.map(query => query.sql)).toContain("ROLLBACK")
  })
})
