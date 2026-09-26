import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { commitTurnTerminal } from "./turn-engine-terminal-commit.js"

const now = new Date("2026-09-25T10:00:00.000Z")
const owner = {
  kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 7,
  leaseExpiresAt: new Date("2026-09-25T10:01:00.000Z"),
}
const input = {
  owner, response: "Final answer", now, stepId: "step-2", finalItemId: "final-1",
  finalContent: { parts: [{ type: "text", text: "Final answer" }] }, stepCount: 2, toolCallCount: 1,
  usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 },
}
type Row = Record<string, unknown>
type Call = { sql: string; values?: readonly unknown[] }

function makePool(pending: readonly { sessionId: string; userId: string; turnId: string; id: string }[] = []) {
  const calls: Call[] = []
  const events = new Map<string, Row>()
  const outboxes = new Map<string, Row>()
  const items = new Map<string, Row>()
  let sequence = 10n
  let turn: Row = { id: owner.turnId, status: "in_progress", finalResponse: null }
  let root: Row = { id: owner.taskId, status: "running", leaseOwner: owner.ownerId, attemptCount: 1, result: null }
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "eventSequence" FROM "agent_sessions"')) return { rows: [{ eventSequence: sequence }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: values?.[0] === owner.sessionId && values?.[1] === owner.userId ? [{ id: owner.sessionId }] : [], rowCount: 1 }
      if (sql.includes('FROM "agent_turns" AS turn')) {
        if (values?.[0] !== owner.turnId || values[1] !== owner.sessionId || values[2] !== owner.userId || values[5] !== owner.taskId) return { rows: [], rowCount: 0 }
        if (turn.status === "completed") return { rows: [{ ...turn }], rowCount: 1 }
        if (values[3] !== owner.ownerId || values[4] !== owner.leaseVersion) return { rows: [], rowCount: 0 }
        return { rows: [{ ...turn }], rowCount: 1 }
      }
      if (sql.includes('FROM "sub_agent_tasks"')) {
        if (values?.[0] !== owner.taskId || values[1] !== owner.sessionId || values[2] !== owner.turnId) return { rows: [], rowCount: 0 }
        return { rows: [{ ...root }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_inputs"')) {
        const found = pending.filter(row => row.sessionId === values?.[0] && row.userId === values[1] && row.turnId === values[2])
        return { rows: found.map(({ id }) => ({ id })), rowCount: found.length }
      }
      if (sql.includes('FROM "agent_events"')) {
        const key = String(values?.length === 3 ? values[2] : values?.[1] ?? "")
        const event = events.get(key)
        if (event) return { rows: [{ ...event }], rowCount: 1 }
        if (key === `turn:${owner.turnId}:event:step-completed:${input.stepId}`) return { rows: [{ id: "step-completed-event" }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('INSERT INTO "agent_items"')) {
        const id = String(values?.[0]);
        if (items.has(id)) return { rows: [], rowCount: 0 }
        const row = { id, sessionId: values?.[1], turnId: values?.[2], stepId: values?.[3], taskId: values?.[4], type: "agent_message", status: "completed", phase: "final_answer", revision: 1, content: JSON.parse(String(values?.[5])) }
        items.set(id, row)
        return { rows: [{ id, revision: 1 }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_items" AS item')) {
        const row = items.get(String(values?.[0]))
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_sessions"')) {
        sequence += 1n
        return { rows: [{ eventSequence: sequence }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_events"')) {
        const [id, sessionId, turnId, itemId, taskId, seq, type, correlationId, causationId, key, payload] = values ?? []
        const row = { id, sessionId, turnId, itemId, taskId, sequence: seq, type, actor: "orchestrator", correlationId, causationId, payload: JSON.parse(String(payload)) }
        events.set(String(key), row)
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        const [id, aggregateId, key, payload] = values ?? []
        if (outboxes.has(String(key))) return { rows: [], rowCount: 0 }
        outboxes.set(String(key), { id, topic: "agent.events", aggregateId, idempotencyKey: key, payload: JSON.parse(String(payload)) })
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_outbox"')) {
        const row = outboxes.get(String(values?.[0]))
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('UPDATE "sub_agent_tasks"')) {
        root = { ...root, status: "completed", result: JSON.parse(String(values?.[0])), leaseOwner: null }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns"')) {
        turn = { ...turn, status: "completed", finalResponse: values?.[0] }
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected query in terminal commit fixture: ${sql}`)
    }),
    release: vi.fn(),
  }
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">,
    calls, events, outboxes, items,
    get state() { return { turn: { ...turn }, root: { ...root } } },
  }
}

describe("atomic Turn terminal commit", () => {
  it("leaves all terminal records untouched when an accepted follow-up wins the session lock", async () => {
    const fake = makePool([{ id: "input-1", sessionId: owner.sessionId, userId: owner.userId, turnId: owner.turnId }])

    await expect(commitTurnTerminal(fake.pool, input)).resolves.toEqual({ status: "pending_follow_up" })

    const lockOrder = [
      fake.calls.findIndex(({ sql }) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")),
      fake.calls.findIndex(({ sql }) => sql.includes('FROM "agent_turns" AS turn') && sql.includes("FOR UPDATE")),
      fake.calls.findIndex(({ sql }) => sql.includes('FROM "sub_agent_tasks"') && sql.includes("FOR UPDATE")),
      fake.calls.findIndex(({ sql }) => sql.includes('FROM "agent_inputs"') && sql.includes("FOR UPDATE")),
    ]
    expect(lockOrder.every(index => index >= 0)).toBe(true)
    expect(lockOrder).toEqual([...lockOrder].sort((a, b) => a - b))
    expect(fake.calls.some(({ sql }) => /INSERT INTO "agent_(items|events|outbox)"|UPDATE "(sub_agent_tasks|agent_turns)"/.test(sql))).toBe(false)
    expect(fake.items.size).toBe(0)
    expect(fake.events.size).toBe(0)
    expect(fake.outboxes.size).toBe(0)
    expect(fake.state.turn.status).toBe("in_progress")
    expect(fake.state.root.status).toBe("running")
  })

  it("commits the final item, event outboxes, root Task and Turn as one idempotent receipt", async () => {
    const fake = makePool()

    const first = await commitTurnTerminal(fake.pool, input)
    const second = await commitTurnTerminal(fake.pool, input)

    expect(first).toMatchObject({ status: "completed", finalItemId: input.finalItemId })
    expect(second).toMatchObject({ status: "completed", finalItemId: input.finalItemId })
    expect(fake.items.size).toBe(1)
    expect(fake.events.size).toBe(3) // the three terminal events; the prerequisite step receipt is fixture-owned
    expect(fake.outboxes.size).toBe(3)
    expect(fake.state.turn).toMatchObject({ status: "completed", finalResponse: input.response })
    expect(fake.state.root).toMatchObject({ status: "completed", leaseOwner: null, result: { finalItemId: input.finalItemId, stepCount: 2, toolCallCount: 1 } })
    expect(fake.calls.filter(({ sql }) => sql.includes('INSERT INTO "agent_events"'))).toHaveLength(3)
    expect(fake.calls.filter(({ sql }) => sql.includes('UPDATE "agent_turns"'))).toHaveLength(1)
    expect(fake.calls.filter(({ sql }) => sql.includes('UPDATE "sub_agent_tasks"'))).toHaveLength(1)
  })

  it("does not let another user's session follow-up gate or cross the owner fence", async () => {
    const otherSession = makePool([{ id: "foreign-input", sessionId: "session-other", userId: "user-other", turnId: "turn-other" }])
    await expect(commitTurnTerminal(otherSession.pool, input)).resolves.toMatchObject({ status: "completed", finalItemId: input.finalItemId })

    const wrongOwner = makePool()
    await expect(commitTurnTerminal(wrongOwner.pool, { ...input, owner: { ...owner, userId: "user-other" } })).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
    expect(wrongOwner.calls.some(({ sql }) => /INSERT INTO "agent_(items|events|outbox)"|UPDATE "(sub_agent_tasks|agent_turns)"/.test(sql))).toBe(false)
  })
})
