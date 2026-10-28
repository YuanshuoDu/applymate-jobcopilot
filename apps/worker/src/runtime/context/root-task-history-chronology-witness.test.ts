import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import {
  acquireRootTaskHistoryChronologyLock, appendRootTaskHistoryChronologyWitness, parseRootTaskHistoryChronologyXid8,
  readRootTaskHistoryChronologyWitness, ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE,
} from "./root-task-history-chronology-witness.js"

const boundary = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  boundary: "turn_start" as const, boundaryEventId: "start-event" }
const parent = { id: boundary.boundaryEventId, sessionId: boundary.sessionId, turnId: boundary.turnId, taskId: boundary.rootTaskId,
  sequence: "7", type: "turn.started", actor: "orchestrator", itemId: null, correlationId: boundary.turnId, causationId: null,
  idempotencyKey: `turn:${boundary.turnId}:event:turn-started`, payload: { taskId: boundary.rootTaskId, rootTaskId: boundary.rootTaskId } }

function fixture(xid8 = "42") {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const events = new Map<string, Record<string, unknown>>([[parent.idempotencyKey, parent]])
  const outboxes = new Map<string, Record<string, unknown>>([[
    `agent-event:${parent.id}`, { id: `agent-outbox-${parent.id}`, topic: "agent.events", aggregateId: parent.sessionId,
      idempotencyKey: `agent-event:${parent.id}`, payload: { eventId: parent.id, sessionId: parent.sessionId, turnId: parent.turnId,
        taskId: parent.taskId, itemId: null, sequence: parent.sequence, type: parent.type, actor: parent.actor,
        correlationId: parent.correlationId, causationId: null, idempotencyKey: parent.idempotencyKey, payload: parent.payload } },
  ]])
  let currentXid8 = xid8
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes("pg_current_xact_id")) return { rows: [{ xid8: currentXid8 }], rowCount: 1 }
    if (sql.includes("FROM \"agent_events\"") && sql.includes('WHERE "id"=$1 AND "sessionId"=$2')) {
      const found = [...events.values()].filter(event => event.id === values?.[0] && event.sessionId === values?.[1]
        && event.turnId === values?.[2] && event.taskId === values?.[3])
      return { rows: found, rowCount: found.length }
    }
    if (sql.includes("FROM \"agent_events\"") && sql.includes("FOR SHARE")) {
      const found = [...events.values()].filter(event => event.idempotencyKey === values?.[0] || event.id === values?.[1])
      return { rows: found, rowCount: found.length }
    }
    if (sql.includes("FROM \"agent_events\"") && sql.includes("FOR UPDATE")) {
      const found = [...events.values()].filter(event => event.idempotencyKey === values?.[0] || event.id === values?.[1])
      return { rows: found, rowCount: found.length }
    }
    if (sql.includes("FROM \"agent_events\"")) {
      const found = [...events.values()].filter(event => event.idempotencyKey === values?.[1])
      return { rows: found, rowCount: found.length }
    }
    if (sql.includes("FROM \"agent_outbox\"")) {
      const found = [...outboxes.values()].filter(row => row.idempotencyKey === values?.[0] || row.id === values?.[1])
      return { rows: found, rowCount: found.length }
    }
    if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "8" }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_events"')) {
      const [id, sessionId, turnId, taskId, sequence, type, causationId, idempotencyKey, rawPayload] = values ?? []
      events.set(String(idempotencyKey), { id, sessionId, turnId, taskId, sequence, type, actor: "orchestrator", itemId: null,
        correlationId: taskId, causationId, idempotencyKey, payload: JSON.parse(String(rawPayload)) })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_outbox"')) {
      const [id, topic, aggregateId, idempotencyKey, rawPayload] = values ?? []
      outboxes.set(String(idempotencyKey), { id, topic, aggregateId, idempotencyKey, payload: JSON.parse(String(rawPayload)) })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }) }
  return { client: client as unknown as Pick<pg.PoolClient, "query">, calls, events, outboxes, setXid8: (value: string) => { currentXid8 = value } }
}

describe("root task history chronology witnesses", () => {
  it("accepts only canonical positive unsigned xid8 values", () => {
    expect(parseRootTaskHistoryChronologyXid8("42")).toBe(42n)
    expect(parseRootTaskHistoryChronologyXid8("18446744073709551615")).toBe((1n << 64n) - 1n)
    for (const invalid of [undefined, 42, "0", "01", "+1", "-1", " 1", "18446744073709551616"]) {
      expect(parseRootTaskHistoryChronologyXid8(invalid)).toBeUndefined()
    }
  })

  it("takes the user advisory lock before capturing xid8, then persists and reads an owner-bound marker", async () => {
    const fake = fixture()
    const lock = await acquireRootTaskHistoryChronologyLock(fake.client, boundary.userId)
    expect(fake.calls[0]?.sql).toContain("pg_advisory_xact_lock")
    expect(fake.calls[1]?.sql).toContain("pg_current_xact_id")
    expect(lock.xid8).toBe("42")

    const saved = await appendRootTaskHistoryChronologyWitness(fake.client, boundary, lock)
    expect(saved).toEqual({ eventId: expect.stringMatching(/^agent-root-task-history-chronology-/), xid8: "42" })
    expect(fake.events.get(`root-task-history-chronology-witness:turn_start:${parent.id}:v1`)).toMatchObject({
      type: ROOT_TASK_HISTORY_CHRONOLOGY_WITNESS_EVENT_TYPE, actor: "orchestrator", causationId: parent.id,
    })
    expect(fake.outboxes.has(`agent-event:${saved.eventId}`)).toBe(true)
    await expect(readRootTaskHistoryChronologyWitness(fake.client, boundary)).resolves.toEqual(saved)
  })

  it("rejects a different transaction xid before writing a marker", async () => {
    const fake = fixture()
    const lock = await acquireRootTaskHistoryChronologyLock(fake.client, boundary.userId)
    fake.setXid8("43")
    await expect(appendRootTaskHistoryChronologyWitness(fake.client, boundary, lock)).rejects.toThrow(/chronology could not be verified/)
    expect(fake.calls.some(call => call.sql.includes('INSERT INTO "agent_events"'))).toBe(false)
  })

  it("accepts a completed parent whose correlation points to its distinct canonical Step", async () => {
    const fake = completedFixture("step-9")
    await expect(readRootTaskHistoryChronologyWitness(fake.client, fake.input)).resolves.toBeUndefined()
    const receipt = fake.calls.find(call => call.sql.includes('FROM "agent_steps" AS step'))
    expect(receipt?.sql).toContain('step."id"=$4')
    expect(receipt?.sql).toContain('item."id"=$5')
    expect(receipt?.sql).toContain('completed."id"=$6')
    expect(receipt?.values?.slice(3, 6)).toEqual(["step-9", "final-1", "final-item-completed"])
  })

  it("rejects a completed parent whose correlation does not identify the completed final-item Step", async () => {
    const fake = completedFixture("turn-1")
    await expect(readRootTaskHistoryChronologyWitness(fake.client, fake.input)).rejects.toThrow(/chronology could not be verified/)
  })

  it("accepts only the canonical completed, failed, and interrupted terminal idempotency keys", async () => {
    const cases = [
      { valid: "turn:turn-1:event:turn-completed", invalid: "turn:turn-1:event:turn-completed:wrong",
        make: (key: string) => completedFixture("step-9", key) },
      { valid: "turn:turn-1:event:turn-failed:provider_error", invalid: "turn:turn-1:event:turn-failed:other_error",
        make: (key: string) => terminalFixture("turn.failed", key) },
      { valid: "turn:turn-1:event:turn-interrupted", invalid: "turn:turn-1:event:turn-interrupted:wrong",
        make: (key: string) => terminalFixture("turn.interrupted", key) },
    ]
    for (const testCase of cases) {
      const valid = testCase.make(testCase.valid)
      await expect(readRootTaskHistoryChronologyWitness(valid.client, valid.input)).resolves.toBeUndefined()
      const invalid = testCase.make(testCase.invalid)
      await expect(readRootTaskHistoryChronologyWitness(invalid.client, invalid.input)).rejects.toThrow(/chronology could not be verified/)
    }
  })
})

function completedFixture(stepCorrelation: string, terminalKey = `turn:${boundary.turnId}:event:turn-completed`) {
  const input = { ...boundary, boundary: "root_terminal" as const, boundaryEventId: "turn-completed-event" }
  const itemId = "final-1"
  const parentEvent = { id: input.boundaryEventId, sessionId: input.sessionId, turnId: input.turnId, taskId: input.rootTaskId,
    sequence: "12", type: "turn.completed", actor: "orchestrator", itemId, correlationId: stepCorrelation,
    causationId: "final-item-completed", idempotencyKey: terminalKey,
    payload: { turnId: input.turnId, taskId: input.rootTaskId, finalItemId: itemId,
      usage: { inputTokens: 2, outputTokens: 3, estimatedCostUsd: 0 } } }
  const completedItemEvent = { id: "final-item-completed", sessionId: input.sessionId, turnId: input.turnId, taskId: input.rootTaskId,
    sequence: "11", type: "item.completed", actor: "orchestrator", itemId, correlationId: itemId, causationId: "final-item-started",
    idempotencyKey: `turn:${input.turnId}:event:final-completed:${itemId}:1`,
    payload: { itemId, status: "completed", content: { text: "answer" } } }
  const outboxes = new Map<string, Record<string, unknown>>()
  for (const row of [parentEvent, completedItemEvent]) {
    const idempotencyKey = `agent-event:${row.id}`
    outboxes.set(idempotencyKey, { id: `agent-outbox-${row.id}`, topic: "agent.events", aggregateId: input.sessionId, idempotencyKey,
      payload: { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, taskId: row.taskId, itemId: row.itemId,
        sequence: row.sequence, type: row.type, actor: row.actor, correlationId: row.correlationId, causationId: row.causationId,
        idempotencyKey: row.idempotencyKey, payload: row.payload } })
  }
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_steps" AS step')) {
      const match = values?.[0] === input.sessionId && values[1] === input.turnId && values[2] === input.rootTaskId
        && values[3] === "step-9" && values[4] === itemId && values[5] === completedItemEvent.id && values[6] === parentEvent.sequence
      return match ? { rows: [completedItemEvent], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM "agent_events"') && sql.includes('WHERE "id"=$1 AND "sessionId"=$2')) {
      return values?.[0] === parentEvent.id ? { rows: [parentEvent], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM "agent_events"')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_outbox"')) {
      const row = [...outboxes.values()].find(entry => entry.idempotencyKey === values?.[0] || entry.id === values?.[1])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  }) }
  return { input, calls, client: client as unknown as Pick<pg.PoolClient, "query"> }
}

function terminalFixture(type: "turn.failed" | "turn.interrupted", idempotencyKey: string) {
  const input = { ...boundary, boundary: "root_terminal" as const, boundaryEventId: `${type}-event` }
  const parentEvent = { ...parent, id: input.boundaryEventId, sequence: "9", type, itemId: null,
    idempotencyKey, payload: { turnId: input.turnId, taskId: input.rootTaskId, errorCode: "provider_error" } }
  const outbox = { id: `agent-outbox-${parentEvent.id}`, topic: "agent.events", aggregateId: input.sessionId,
    idempotencyKey: `agent-event:${parentEvent.id}`, payload: { eventId: parentEvent.id, sessionId: input.sessionId,
      turnId: input.turnId, taskId: input.rootTaskId, itemId: null, sequence: parentEvent.sequence, type,
      actor: "orchestrator", correlationId: parentEvent.correlationId, causationId: null, idempotencyKey, payload: parentEvent.payload } }
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM "agent_events"') && sql.includes('WHERE "id"=$1 AND "sessionId"=$2')) {
      return values?.[0] === parentEvent.id ? { rows: [parentEvent], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM "agent_outbox"')) {
      return values?.[0] === outbox.idempotencyKey || values?.[1] === outbox.id
        ? { rows: [outbox], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }) }
  return { input, client: client as unknown as Pick<pg.PoolClient, "query"> }
}
