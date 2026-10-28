import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { appendTurnEngineEventBatch } from "./turn-engine-event-batch.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import type { TurnEngineEventInput } from "./turn-engine-types.js"

const owner = { kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
  rootTaskId: "root-1", ownerId: "owner-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-10-20T12:01:00Z") }
const input: TurnEngineEventInput = { owner, id: "turn:turn-1:event:turn-started", itemId: null, type: "turn.started",
  correlationId: owner.turnId, causationId: null, idempotencyKey: "turn:turn-1:event:turn-started",
  payload: { goal: "Find a role", taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId } }

function fixture() {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const events = new Map<string, Record<string, unknown>>()
  const outboxes = new Map<string, Record<string, unknown>>()
  let sequence = 0
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (sql.includes("pg_current_xact_id")) return { rows: [{ xid8: "101" }], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) {
      if (sql.includes('WHERE "id"=$1 AND "sessionId"=$2')) {
        const row = [...events.values()].find(event => event.id === values?.[0] && event.sessionId === values?.[1]
          && event.turnId === values?.[2] && event.taskId === values?.[3])
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
      }
      const row = [...events.values()].find(event => event.idempotencyKey === values?.[0] || event.id === values?.[1]
        || event.idempotencyKey === values?.[1])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_outbox"')) {
      const row = [...outboxes.values()].find(entry => entry.idempotencyKey === values?.[0] || entry.id === values?.[1])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('UPDATE "agent_sessions"')) { sequence += 1; return { rows: [{ eventSequence: String(sequence) }], rowCount: 1 } }
    if (sql.includes('INSERT INTO "agent_events"')) {
      let event: Record<string, unknown>
      if (/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*NULL,\s*\$4,\s*\$5,\s*\$6,\s*'orchestrator'/.test(sql)) {
        const [id, sessionId, turnId, taskId, eventSequence, type, causationId, idempotencyKey, payload] = values ?? []
        event = { id, sessionId, turnId, taskId, sequence: eventSequence, type, actor: "orchestrator", itemId: null,
          correlationId: taskId, causationId, idempotencyKey, payload: JSON.parse(String(payload)) }
      } else {
        const [id, sessionId, turnId, itemId, taskId, eventSequence, type, actor, correlationId, causationId, idempotencyKey, payload] = values ?? []
        event = { id, sessionId, turnId, itemId, taskId, sequence: eventSequence, type, actor, correlationId, causationId,
          idempotencyKey, payload: JSON.parse(String(payload)) }
      }
      events.set(String(event.idempotencyKey), event)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_outbox"')) {
      const [id, topic, aggregateId, idempotencyKey, payload] = values?.length === 5
        ? values : [values?.[0], "agent.events", values?.[1], values?.[2], values?.[3]]
      outboxes.set(String(idempotencyKey), { id, topic, aggregateId, idempotencyKey, payload: JSON.parse(String(payload)) })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { calls, client, pool, events, outboxes }
}

function defaultEventWriter(fake: ReturnType<typeof fixture>, submitted: TurnEngineEventInput[]) {
  const appendEvent: TurnExecutionOptions["store"]["appendEvent"] = async event => {
    const persistedInput: TurnEngineEventInput = {
      owner: event.identity, id: event.id, itemId: event.itemId, type: event.type,
      correlationId: event.correlationId, causationId: event.causationId,
      idempotencyKey: event.idempotencyKey, payload: event.payload,
    }
    submitted.push(persistedInput)
    const persisted = await appendTurnEngineEventBatch(fake.pool, [persistedInput])
    const result = persisted[0]
    if (!result) throw new Error("event batch omitted the persisted event")
    return result
  }
  return new TurnExecutionEventWriter({ identity: owner, store: { appendEvent } } as unknown as TurnExecutionOptions)
}

describe("TurnEngine event batch chronology", () => {
  it("binds a random writer start ID across first write, idempotent replay, and strict identity rejection", async () => {
    const fake = fixture(), submitted: TurnEngineEventInput[] = []
    const startKey = `turn:${owner.turnId}:event:turn-started`
    const appendStart = (goal = "Find a role") => defaultEventWriter(fake, submitted).append("turn.started", owner.turnId, null,
      { goal, taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId }, "turn-started")

    const firstId = await appendStart()
    expect(submitted[0]?.id).toMatch(/^turn:turn-1:event:turn-started:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
    expect(submitted[0]?.idempotencyKey).toBe(startKey)
    expect(firstId).toBe(submitted[0]?.id)
    const parent = fake.events.get(startKey)
    const witnessKey = `root-task-history-chronology-witness:turn_start:${firstId}:v1`
    const witness = fake.events.get(witnessKey)
    expect(parent).toMatchObject({ id: firstId, type: "turn.started", idempotencyKey: startKey })
    expect(witness).toMatchObject({ idempotencyKey: witnessKey, causationId: firstId,
      payload: { boundary: "turn_start", boundaryEventId: firstId } })
    expect(fake.outboxes.get(`agent-event:${firstId}`)).toMatchObject({ payload: { eventId: firstId, idempotencyKey: startKey } })
    expect(fake.outboxes.get(`agent-event:${String(witness?.id)}`)).toMatchObject({
      id: `agent-outbox-${String(witness?.id)}`, payload: { eventId: witness?.id, causationId: firstId },
    })
    const eventInsertCount = () => fake.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"')).length
    const writesBeforeReplay = eventInsertCount()

    const replayId = await appendStart()
    expect(submitted[1]?.id).not.toBe(submitted[0]?.id)
    expect(submitted[1]?.idempotencyKey).toBe(startKey)
    expect(replayId).toBe(firstId)
    expect(eventInsertCount()).toBe(writesBeforeReplay)
    expect(fake.events.size).toBe(2)

    await expect(appendStart("Changed objective")).rejects.toThrow(`event ${startKey} identity`)
    expect(submitted[2]?.idempotencyKey).toBe(startKey)
    expect(eventInsertCount()).toBe(writesBeforeReplay)
    expect(fake.events.get(startKey)).toMatchObject({ id: firstId, payload: { goal: "Find a role" } })
  })

  it("rejects an empty persisted ID for the reserved root start boundary", async () => {
    const fake = fixture()
    await expect(appendTurnEngineEventBatch(fake.pool, [{ ...input, id: "" }])).rejects.toThrow("root turn-start boundary")
    expect(fake.calls).toHaveLength(0)
  })

  it("rejects the canonical start key when its payload names a different Root", async () => {
    const fake = fixture()
    await expect(appendTurnEngineEventBatch(fake.pool, [{
      ...input, id: `${input.id}:random-id`, payload: { goal: "Find a role", taskId: "foreign-root", rootTaskId: "foreign-root" },
    }])).rejects.toThrow("root turn-start boundary")
    expect(fake.calls).toHaveLength(0)
  })

  it("serializes root start, writes a paired private witness, and validates replay without backfill", async () => {
    const fake = fixture()
    await expect(appendTurnEngineEventBatch(fake.pool, [input])).resolves.toEqual([{ id: input.id }])
    const lock = fake.calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock"))
    const xid = fake.calls.findIndex(call => call.sql.includes("pg_current_xact_id"))
    const session = fake.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"') && call.sql.includes("FOR UPDATE"))
    const turn = fake.calls.findIndex(call => call.sql.includes('SELECT turn."id"'))
    const writes = fake.calls.flatMap((call, index) => call.sql.includes('INSERT INTO "agent_events"') ? [index] : [])
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(xid)
    expect(xid).toBeLessThan(session)
    expect(session).toBeLessThan(turn)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toBeGreaterThan(turn)
    expect(writes[1]).toBeGreaterThan(writes[0])
    expect(fake.events.size).toBe(2)
    expect(fake.outboxes.size).toBe(2)

    await appendTurnEngineEventBatch(fake.pool, [input])
    expect(fake.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(2)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })

  it("does not record an unrelated or child start as a root chronology boundary", async () => {
    const unrelated = { ...input, id: "custom-start", idempotencyKey: "custom-start" }
    const fake = fixture()
    await appendTurnEngineEventBatch(fake.pool, [unrelated])
    expect(fake.calls.some(call => call.sql.includes("pg_advisory_xact_lock"))).toBe(false)
    const childOwner = { kind: "task" as const, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      taskId: "child-1", rootTaskId: owner.rootTaskId, ownerId: owner.ownerId, leaseExpiresAt: owner.leaseExpiresAt, attemptCount: 1 }
    const child = { ...input, owner: childOwner, id: "child-start", idempotencyKey: "child-start" }
    const childFake = fixture()
    await appendTurnEngineEventBatch(childFake.pool, [child])
    expect(childFake.calls.some(call => call.sql.includes("pg_advisory_xact_lock"))).toBe(false)
  })
})
