import type pg from "pg"
import { describe, expect, it, vi } from "vitest"

import { AGENT_EVENT_OUTBOX_TOPIC, drainAgentEventOutbox } from "./outbox-consumer.js"

type OutboxRow = {
  id: string
  aggregateId: string
  payload: unknown
  publishedAt: Date | null
  attemptCount: number
  lastError: string | null
  createdAt: Date
}

type EventRow = {
  id: string
  sessionId: string
  turnId: string | null
  itemId: string | null
  taskId: string | null
  sequence: bigint
  type: string
  actor: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  payload: unknown
  createdAt: string
}

const event: EventRow = {
  id: "event-1", sessionId: "session-1", turnId: "turn-1", itemId: null, taskId: null, sequence: 7n,
  type: "turn.resumed", actor: "system", correlationId: "turn-1", causationId: "wait-1",
  idempotencyKey: "agent-wait:wait-1:resumed", payload: { waitId: "wait-1", status: "ready" }, createdAt: "2026-09-22T10:00:00.000Z",
}

const gmailEvent: EventRow = {
  id: "gmail-event-1", sessionId: "session-1", turnId: "turn-1", itemId: null, taskId: null, sequence: 9n,
  type: "gmail.sent", actor: "orchestrator", correlationId: "turn-1", causationId: null,
  idempotencyKey: "gmail-send:send-1:evidence", payload: { evidenceId: "evidence-1", messageId: "message-1", jobId: "job-1" },
  createdAt: "2026-09-22T10:00:00.000Z",
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: event.id, sessionId: event.sessionId, turnId: event.turnId, itemId: event.itemId, taskId: event.taskId,
    sequence: event.sequence.toString(), type: event.type, actor: event.actor, correlationId: event.correlationId,
    causationId: event.causationId, idempotencyKey: event.idempotencyKey, payload: event.payload, ...overrides,
  }
}

function outbox(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "outbox-1", aggregateId: event.sessionId, payload: payload(), publishedAt: null, attemptCount: 0, lastError: null,
    createdAt: new Date("2026-09-22T09:00:00.000Z"), ...overrides,
  }
}

function fakePool(rows: OutboxRow[] = [outbox()], events: EventRow[] = [event]) {
  const outboxRows = new Map(rows.map(row => [row.id, { ...row }]))
  const eventRows = new Map(events.map(row => [row.id, { ...row }]))
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  let snapshot: OutboxRow[] | null = null
  const client = {
    query: vi.fn(async <T = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql === "BEGIN") {
        snapshot = [...outboxRows.values()].map(row => ({ ...row }))
        return { rows: [], rowCount: 0 }
      }
      if (sql === "COMMIT") { snapshot = null; return { rows: [], rowCount: 0 } }
      if (sql === "ROLLBACK") {
        if (snapshot) {
          outboxRows.clear()
          for (const row of snapshot) outboxRows.set(row.id, { ...row })
        }
        snapshot = null
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "agent_outbox"') && sql.includes('"publishedAt" IS NULL') && sql.includes("LIMIT")) {
        const limit = Number(values[1])
        const selected = [...outboxRows.values()]
          .filter(row => row.publishedAt === null)
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
          .slice(0, limit)
        return { rows: selected as T[], rowCount: selected.length }
      }
      if (sql.includes('FROM "agent_outbox" WHERE "id" = $1')) {
        const row = outboxRows.get(String(values[0]))
        return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('FROM "agent_events"')) {
        const row = eventRows.get(String(values[0]))
        const matching = row && row.sessionId === String(values[1]) ? row : undefined
        return { rows: matching ? [matching as T] : [], rowCount: matching ? 1 : 0 }
      }
      if (sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) {
        const row = outboxRows.get(String(values[0]))
        if (row && row.publishedAt === null) {
          row.publishedAt = new Date("2026-09-22T10:01:00.000Z")
          row.attemptCount += 1
          row.lastError = values[1] === null ? null : String(values[1])
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('SET "attemptCount" = "attemptCount" + 1')) {
        const row = outboxRows.get(String(values[0]))
        if (row && row.publishedAt === null) {
          row.attemptCount += 1
          row.lastError = String(values[1])
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { client, pool, outboxRows, calls }
}

function publisher() {
  return { publish: vi.fn().mockResolvedValue(1), xadd: vi.fn().mockResolvedValue("1-0") }
}

function publishedEnvelope(redis: ReturnType<typeof publisher>): Record<string, unknown> {
  const message = redis.publish.mock.calls[0]?.[1]
  return JSON.parse(String(message)) as Record<string, unknown>
}

describe("agent event outbox consumer", () => {
  it("selects a bounded locked batch, validates the event, publishes it, and records delivery", async () => {
    const fake = fakePool()
    const redis = publisher()

    await expect(drainAgentEventOutbox(fake.pool, redis, 99)).resolves.toBe(1)

    expect(redis.publish).toHaveBeenCalledWith("agent:session:session-1:events", expect.stringContaining('"sequence":"7"'))
    expect(fake.outboxRows.get("outbox-1")).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, lastError: null })
    const select = fake.calls.find(call => call.sql.includes('FROM "agent_outbox"') && call.sql.includes("LIMIT"))
    expect(select?.sql).toContain('WHERE "topic" = $1 AND "publishedAt" IS NULL')
    expect(select?.sql).toContain("LIMIT $2 FOR UPDATE SKIP LOCKED")
    expect(select?.values).toEqual([AGENT_EVENT_OUTBOX_TOPIC, 50])
    expect(fake.calls.some(call => call.sql.includes('FROM "agent_events"') && call.sql.includes("FOR SHARE"))).toBe(true)
  })

  it("publishes a sparse mailbox envelope from the canonical event row", async () => {
    const fake = fakePool([outbox({ payload: {
      eventId: event.id, sessionId: event.sessionId, turnId: event.turnId, itemId: event.itemId, taskId: event.taskId, type: event.type,
    } })])
    const redis = publisher()

    await expect(drainAgentEventOutbox(fake.pool, redis)).resolves.toBe(1)

    expect(redis.publish).toHaveBeenCalledTimes(1)
    expect(publishedEnvelope(redis)).toMatchObject({
      id: event.id, sessionId: event.sessionId, turnId: event.turnId, itemId: event.itemId, taskId: event.taskId,
      sequence: event.sequence.toString(), type: event.type, actor: event.actor, correlationId: event.correlationId,
      causationId: event.causationId, idempotencyKey: event.idempotencyKey, payload: event.payload,
    })
  })

  it("publishes a sparse Gmail envelope from the canonical event row", async () => {
    const fake = fakePool([outbox({
      id: "gmail-outbox-1",
      payload: {
        eventId: gmailEvent.id, sessionId: gmailEvent.sessionId, turnId: gmailEvent.turnId, type: gmailEvent.type,
        actor: gmailEvent.actor, idempotencyKey: gmailEvent.idempotencyKey, payload: gmailEvent.payload,
      },
    })], [gmailEvent])
    const redis = publisher()

    await expect(drainAgentEventOutbox(fake.pool, redis)).resolves.toBe(1)

    expect(redis.publish).toHaveBeenCalledTimes(1)
    expect(publishedEnvelope(redis)).toMatchObject({
      id: gmailEvent.id, sessionId: gmailEvent.sessionId, turnId: gmailEvent.turnId, itemId: gmailEvent.itemId,
      taskId: gmailEvent.taskId, sequence: gmailEvent.sequence.toString(), type: gmailEvent.type, actor: gmailEvent.actor,
      correlationId: gmailEvent.correlationId, causationId: gmailEvent.causationId, idempotencyKey: gmailEvent.idempotencyKey,
      payload: gmailEvent.payload,
    })
  })

  it.each([
    ["malformed payload", { payload: { eventId: event.id } }, "schema_invalid_payload"],
    ["unknown envelope field", { payload: { ...payload(), extra: true } }, "schema_invalid_payload"],
    ["aggregate mismatch", { aggregateId: "other-session" }, "outbox_scope_mismatch"],
    ["missing event", { payload: payload({ eventId: "missing-event" }) }, "event_lineage_mismatch"],
    ["event identity mismatch", { payload: payload({ type: "turn.failed" }) }, "event_lineage_mismatch"],
  ])("terminalizes %s rows without publishing", async (_label, overrides, lastError) => {
    const fake = fakePool([outbox(overrides as Partial<OutboxRow>)])
    const redis = publisher()

    await expect(drainAgentEventOutbox(fake.pool, redis)).resolves.toBe(1)

    expect(redis.publish).not.toHaveBeenCalled()
    expect(fake.outboxRows.get("outbox-1")).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, lastError })
  })

  it.each([
    ["session", {}], ["turn", { turnId: "other-turn" }], ["sequence", { sequence: "8" }],
    ["type", { type: "turn.failed" }], ["actor", { actor: "orchestrator" }], ["correlationId", { correlationId: "other-turn" }],
    ["causationId", { causationId: "other-wait" }], ["idempotencyKey", { idempotencyKey: "other-key" }],
    ["payload", { payload: { waitId: "wait-2", status: "ready" } }],
  ])("terminalizes a referenced event %s identity mismatch", async (_field, change) => {
    const field = String(_field)
    const fake = field === "session"
      ? fakePool([outbox()], [{ ...event, sessionId: "other-session" }])
      : fakePool([outbox({ payload: payload(change) })])
    const redis = publisher()

    await expect(drainAgentEventOutbox(fake.pool, redis)).resolves.toBe(1)

    expect(redis.publish).not.toHaveBeenCalled()
    expect(fake.outboxRows.get("outbox-1")).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, lastError: "event_lineage_mismatch" })
  })

  it("records a bounded retry error and leaves a Redis failure unpublished", async () => {
    const fake = fakePool()
    const redis = publisher()
    redis.publish.mockRejectedValueOnce(new Error("redis connection dropped"))

    await expect(drainAgentEventOutbox(fake.pool, redis)).resolves.toBe(0)
    expect(fake.outboxRows.get("outbox-1")).toMatchObject({ publishedAt: null, attemptCount: 1, lastError: "publish_failed" })

    await expect(drainAgentEventOutbox(fake.pool, redis)).resolves.toBe(1)
    expect(fake.outboxRows.get("outbox-1")).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 2, lastError: null })
  })

  it("does not select more than the bounded maximum", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => outbox({ id: `outbox-${String(index).padStart(2, "0")}`, createdAt: new Date(1_000 + index) }))
    const fake = fakePool(rows)
    const redis = publisher()

    await expect(drainAgentEventOutbox(fake.pool, redis, 100)).resolves.toBe(50)
    expect([...fake.outboxRows.values()].filter(row => row.publishedAt !== null)).toHaveLength(50)
  })
})
