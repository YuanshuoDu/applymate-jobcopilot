import type pg from "pg"
import { describe, expect, it } from "vitest"

import { PgCoordinationStore } from "./store.js"
import type { CoordinationTaskView } from "../tools/coordination-types.js"

type QueryRecord = { sql: string; values: readonly unknown[] }

const task: CoordinationTaskView = {
  id: "task-1", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "task-1", parentTaskId: null,
  path: "/task-1", depth: 0, role: "scout", taskType: "inspect", status: "queued", goal: "Inspect",
  attemptCount: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
}

class FakeClient {
  readonly queries: QueryRecord[] = []
  private readonly rows: Record<string, unknown>

  constructor(private readonly mode: "task" | "empty" = "task") {
    this.rows = { ...task, createdAt: new Date("2026-09-03T00:00:00.000Z") }
  }

  async query(sql: unknown, values: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const text = String(sql)
    this.queries.push({ sql: text, values })
    if (text.includes("FROM \"sub_agent_tasks\" task") && text.includes("SELECT")) return { rows: this.mode === "task" ? [this.rows] : [], rowCount: this.mode === "task" ? 1 : 0 }
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

  it("writes mailbox message and outbox notification in one tenant-scoped transaction", async () => {
    const client = new FakeClient()
    const store = new PgCoordinationStore(pool(client))
    const result = await store.sendMessage({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", fromTaskId: null, toTaskId: "task-1", kind: "result", payload: { ok: true }, idempotencyKey: "message-1" })
    expect(result).toMatchObject({ duplicate: false, message: { idempotencyKey: "message-1", toTaskId: "task-1" } })
    const sql = client.queries.map(query => query.sql).join("\n")
    expect(sql).toMatch(/BEGIN[\s\S]*INSERT INTO "agent_mailbox_messages"[\s\S]*agent\.subagent\.mailbox[\s\S]*COMMIT/)
    expect(client.queries.find(query => query.sql.includes("set_config('app.user_id'"))?.values).toContain("user-a")
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

  it("projects coordination activity as an item, event, and session outbox notification", async () => {
    const client = new FakeClient()
    const store = new PgCoordinationStore(pool(client))
    await store.appendActivity({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", stepId: "step-a", taskId: "task-1", operation: "list_subagents", status: "completed", idempotencyKey: "call-1:list", data: { count: 1 } })
    const sql = client.queries.map(query => query.sql).join("\n")
    expect(sql).toMatch(/INSERT INTO "agent_items"[\s\S]*INSERT INTO "agent_events"[\s\S]*agent\.session\.event/)
    expect(client.queries.some(query => query.sql.includes("UPDATE \"agent_sessions\" SET \"eventSequence\""))).toBe(true)
  })
})
