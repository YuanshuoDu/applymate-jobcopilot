import type pg from "pg"
import { describe, expect, it } from "vitest"

import { hydrateChildMailbox, type ChildMailboxHydrationInput } from "./hydration.js"
import type { CoordinationMailboxMessage } from "../tools/coordination-types.js"

type Call = { readonly sql: string; readonly values: readonly unknown[] }
type Checkpoint = Omit<ChildMailboxHydrationInput, "ownerId" | "limit" | "toTaskId"> & { readonly id: string; readonly taskId: string; readonly messageId: string }
type State = {
  sessionUser: string
  sessionStatus: string
  targetStatus: string
  targetOwner: string
  targetAttempt: number
  targetInterrupt: Date | null
  leaseExpiresAt: Date
  rootStatus: string
  turnStatus: string
  stepStatus: string
  stepAttempt: number
  messages: CoordinationMailboxMessage[]
  checkpoints: Checkpoint[]
  failOnInsert: boolean
}

const input: ChildMailboxHydrationInput = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", toTaskId: "child-a",
  ownerId: "worker-a", attemptCount: 2, stepId: "step-a", limit: 20,
}
const now = new Date("2026-09-14T12:00:00.000Z")

function message(id: string, createdAt = now, payload: unknown = { id }): CoordinationMailboxMessage {
  return { id, sessionId: input.sessionId, turnId: input.turnId, fromTaskId: "root-a", toTaskId: input.toTaskId,
    kind: "result", payload, idempotencyKey: `key-${id}`, createdAt, deliveredAt: null, consumedAt: null }
}

function state(overrides: Partial<State> = {}): State {
  return {
    sessionUser: input.userId, sessionStatus: "running", targetStatus: "running", targetOwner: input.ownerId,
    targetAttempt: input.attemptCount, targetInterrupt: null, leaseExpiresAt: new Date("2026-09-14T13:00:00.000Z"),
    rootStatus: "running", turnStatus: "in_progress", stepStatus: "streaming", stepAttempt: input.attemptCount,
    messages: [message("message-b", new Date("2026-09-14T11:00:00.000Z")), message("message-a", new Date("2026-09-14T11:00:00.000Z"))],
    checkpoints: [], failOnInsert: false, ...overrides,
  }
}

class FakeClient {
  readonly calls: Call[] = []
  constructor(readonly db: State) {}

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<pg.QueryResult<T>> {
    this.calls.push({ sql, values })
    const empty = (): pg.QueryResult<T> => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] })
    const rows = (items: readonly Record<string, unknown>[], rowCount = items.length): pg.QueryResult<T> => ({ rows: items as T[], rowCount, command: "SELECT", oid: 0, fields: [] })
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config('app.user_id'")) return rows([], 0)
    if (sql.includes('FROM "agent_sessions" AS session') && sql.includes("FOR UPDATE")) {
      return this.db.sessionUser === values[1] && this.db.sessionStatus === "running" ? rows([{ id: input.sessionId }]) : empty()
    }
    if (sql.includes('FROM "sub_agent_tasks" AS target') && sql.includes('SELECT target."id"')) {
      const valid = values[0] === input.toTaskId && values[1] === input.sessionId && values[2] === input.userId && values[3] === input.turnId
        && values[4] === input.rootTaskId && values[5] === this.db.targetOwner && values[6] === this.db.targetAttempt
        && this.db.targetStatus === "running" && this.db.targetInterrupt === null && this.db.leaseExpiresAt > now
      return valid ? rows([{ id: input.toTaskId }]) : empty()
    }
    if (sql.includes('FROM "sub_agent_tasks" AS root')) {
      const valid = values[0] === input.rootTaskId && values[1] === input.sessionId && values[2] === input.turnId && values[3] === input.userId
        && this.db.rootStatus === "running"
      return valid ? rows([{ id: input.rootTaskId }]) : empty()
    }
    if (sql.includes('FROM "agent_turns" AS turn')) {
      const valid = values[0] === input.turnId && values[1] === input.sessionId && values[2] === input.userId && values[3] === input.rootTaskId
        && this.db.turnStatus === "in_progress"
      return valid ? rows([{ id: input.turnId }]) : empty()
    }
    if (sql.includes('FROM "agent_steps" AS step')) {
      const valid = values[0] === input.stepId && values[1] === input.turnId && values[2] === input.sessionId && values[3] === input.toTaskId
        && values[4] === this.db.stepAttempt && this.db.stepStatus === "streaming"
      return valid ? rows([{ id: input.stepId }]) : empty()
    }
    if (sql.includes('FROM "agent_mailbox_hydration_checkpoints" AS checkpoint') && sql.includes('SELECT checkpoint."id"')) {
      return rows(this.db.checkpoints.filter(row => row.userId === values[0] && row.sessionId === values[1] && row.turnId === values[2]
        && row.rootTaskId === values[3] && row.taskId === values[4] && row.attemptCount === values[5]).map(row => ({ id: row.id })))
    }
    if (sql.includes('LEFT JOIN "agent_mailbox_hydration_checkpoints"')) {
      const cp = this.db.checkpoints.filter(row => row.sessionId === values[1] && row.taskId === values[4] && row.attemptCount === values[6])
      const ids = new Set(cp.map(row => row.messageId))
      const selected = this.pending(values).filter(row => !ids.has(row.id)).slice(0, Number(values[7]))
      return rows(selected as unknown as Record<string, unknown>[])
    }
    if (sql.includes('FROM "agent_mailbox_hydration_checkpoints" AS checkpoint') && sql.includes('SELECT message."id"')) {
      const ids = new Set(this.db.checkpoints.filter(row => row.userId === values[0] && row.sessionId === values[1] && row.turnId === values[2]
        && row.rootTaskId === values[3] && row.taskId === values[4] && row.attemptCount === values[5]).map(row => row.messageId))
      return rows(this.pending(values).filter(row => ids.has(row.id)).slice(0, Number(values[6])) as unknown as Record<string, unknown>[])
    }
    if (sql.includes('INSERT INTO "agent_mailbox_hydration_checkpoints"')) {
      if (this.db.failOnInsert) throw new Error("insert failed")
      const key = String(values[8])
      if (!this.db.checkpoints.some(row => row.messageId === key && row.taskId === values[5] && row.attemptCount === values[6])) {
        this.db.checkpoints.push({ id: String(values[0]), userId: String(values[1]), sessionId: String(values[2]), turnId: String(values[3]), rootTaskId: String(values[4]), taskId: String(values[5]), attemptCount: Number(values[6]), stepId: String(values[7]), messageId: key })
        return rows([], 1)
      }
      return rows([], 0)
    }
    return empty()
  }

  private pending(values: readonly unknown[]): CoordinationMailboxMessage[] {
    return this.db.messages.filter(row => row.sessionId === values[1] && row.turnId === values[2] && row.toTaskId === values[4] && row.consumedAt === null)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
  }

  release(): void {}
}

function pool(client: FakeClient): Pick<pg.Pool, "connect"> { return { connect: async () => client as unknown as pg.PoolClient } }
async function hydrate(db: State, overrides: Partial<ChildMailboxHydrationInput> = {}): Promise<{ result: CoordinationMailboxMessage[]; client: FakeClient }> {
  const client = new FakeClient(db)
  return { result: await hydrateChildMailbox(pool(client), { ...input, ...overrides }), client }
}

describe("hydrateChildMailbox", () => {
  it("hydrates pending messages once, in stable order, without mailbox or outbox side effects", async () => {
    const db = state()
    const before = db.messages.map(row => ({ id: row.id, deliveredAt: row.deliveredAt, consumedAt: row.consumedAt }))
    const { result, client } = await hydrate(db)
    expect(result.map(row => row.id)).toEqual(["message-a", "message-b"])
    expect(db.checkpoints).toHaveLength(2)
    expect(db.messages.map(row => ({ id: row.id, deliveredAt: row.deliveredAt, consumedAt: row.consumedAt }))).toEqual(before)
    expect(client.calls.some(call => /^\s*UPDATE\b/.test(call.sql) || call.sql.includes("agent_outbox"))).toBe(false)
    expect(client.calls.find(call => call.sql.includes("lockCheckpoints") || call.sql.includes('SELECT checkpoint."id"'))?.values).toEqual([input.userId, input.sessionId, input.turnId, input.rootTaskId, input.toTaskId, input.attemptCount])
  })

  it("replays the same attempt and appends new messages without duplicating checkpoints", async () => {
    const db = state()
    const first = await hydrate(db)
    db.messages.push(message("message-c", new Date("2026-09-14T11:30:00.000Z")))
    const second = await hydrate(db)
    expect(first.result.map(row => row.id)).toEqual(["message-a", "message-b"])
    expect(second.result.map(row => row.id)).toEqual(["message-a", "message-b", "message-c"])
    expect(db.checkpoints).toHaveLength(3)
    expect(new Set(db.checkpoints.map(row => row.id)).size).toBe(3)
  })

  it("caps at twenty and preserves createdAt/id order", async () => {
    const db = state({ messages: Array.from({ length: 25 }, (_, index) => message(`message-${String(index).padStart(2, "0")}`, now)) })
    const { result } = await hydrate(db)
    expect(result).toHaveLength(20)
    expect(result.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => `message-${String(index).padStart(2, "0")}`))
  })

  it.each([
    ["foreign user", { userId: "user-b" }], ["foreign session", { sessionId: "session-b" }], ["foreign turn", { turnId: "turn-b" }],
    ["foreign root", { rootTaskId: "root-b" }], ["foreign task", { toTaskId: "child-b" }], ["foreign step", { stepId: "step-b" }],
    ["old attempt", { attemptCount: 1 }],
  ] as const)("fails closed for %s before checkpoint insert", async (_label, overrides) => {
    const db = state()
    await expect(hydrate(db, overrides)).rejects.toThrow()
    expect(db.checkpoints).toHaveLength(0)
  })

  it.each([
    ["stale owner", { targetOwner: "worker-b" }], ["interrupted", { targetInterrupt: now }], ["closed target", { targetStatus: "closed" }],
    ["closed root", { rootStatus: "closed" }], ["terminal turn", { turnStatus: "completed" }], ["terminal step", { stepStatus: "completed" }],
  ] as const)("fails closed for %s without side effects", async (_label, overrides) => {
    const db = state(overrides)
    await expect(hydrate(db)).rejects.toThrow()
    expect(db.checkpoints).toHaveLength(0)
  })

  it("rolls back partial inserts and exposes idempotent conflict SQL", async () => {
    const db = state({ failOnInsert: true })
    const client = new FakeClient(db)
    await expect(hydrateChildMailbox(pool(client), input)).rejects.toThrow("insert failed")
    expect(client.calls.map(call => call.sql)).toContain("ROLLBACK")
    expect(client.calls.find(call => call.sql.includes("INSERT INTO \"agent_mailbox_hydration_checkpoints\""))?.sql).toContain("ON CONFLICT")
  })

  it("sets RLS identity and follows the session, task, lineage, checkpoint, mailbox lock order", async () => {
    const { client } = await hydrate(state())
    const order = [
      'FROM "agent_sessions" AS session', 'FROM "sub_agent_tasks" AS target', 'FROM "sub_agent_tasks" AS root', 'FROM "agent_turns" AS turn',
      'FROM "agent_steps" AS step', 'FROM "agent_mailbox_hydration_checkpoints" AS checkpoint', 'FROM "agent_mailbox_messages" AS message',
    ].map(fragment => client.calls.findIndex(call => call.sql.includes(fragment) && call.sql.includes("FOR UPDATE")))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(client.calls.find(call => call.sql.includes("set_config('app.user_id'"))?.values).toEqual([input.userId])
  })

  it("rejects missing, unsafe, and over-limit input before opening a connection", async () => {
    const connect = async () => { throw new Error("connection must not be opened") }
    const invalid = { ...input, limit: 21 } as ChildMailboxHydrationInput
    await expect(hydrateChildMailbox({ connect }, invalid)).rejects.toMatchObject({ code: "coordination_invalid_input" })
  })
})
