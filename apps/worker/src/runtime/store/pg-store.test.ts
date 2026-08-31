import { readFileSync } from "node:fs"

import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import {
  runRepositoryFixture,
  type AgentEventRecord,
  type AgentItemRecord,
  type AgentStepRecord,
  type AgentTurnRecord,
  type RepositoryFixture,
} from "@jobcopilot/agent-protocol"

import { createPgAgentStore } from "./pg-store.js"

function fixture(): RepositoryFixture {
  return {
    scope: { userId: "user_fixture" },
    sessionId: "session_fixture",
    turnId: "turn_fixture",
    itemId: "item_fixture",
    stepId: "step_fixture",
    eventId: "event_fixture",
    idempotencyKey: "event_fixture_key",
  }
}

function makeFakePool(ownerId = "user_fixture", failOutbox = false, staleItem = false) {
  const f = fixture()
  let turn: AgentTurnRecord = { id: f.turnId, sessionId: f.sessionId, userId: ownerId, source: "user", status: "queued", revision: 0, createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" }
  let item: AgentItemRecord = { id: f.itemId, sessionId: f.sessionId, turnId: f.turnId, stepId: null, taskId: null, type: "agent_message", status: "started", phase: "commentary", revision: 0, content: { text: "initial" }, startedAt: null, completedAt: null, createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" }
  const steps: AgentStepRecord[] = []
  const events: AgentEventRecord[] = []
  let eventSequence = BigInt(0)
  let snapshot: { turn: AgentTurnRecord; item: AgentItemRecord; eventSequence: bigint; steps: AgentStepRecord[]; events: AgentEventRecord[] } | null = null

  const client = {
    query: vi.fn(async (sql: unknown, values: readonly unknown[] = []) => {
      const text = String(sql)
      if (text === "BEGIN") {
        snapshot = { turn: { ...turn }, item: { ...item }, eventSequence, steps: [...steps], events: [...events] }
        return { rows: [] }
      }
      if (text === "COMMIT") return { rows: [] }
      if (text === "ROLLBACK") {
        if (snapshot) {
          turn = snapshot.turn
          item = snapshot.item
          eventSequence = snapshot.eventSequence
          steps.splice(0, steps.length, ...snapshot.steps)
          events.splice(0, events.length, ...snapshot.events)
        }
        return { rows: [] }
      }
      if (text.includes("set_config")) return { rows: [] }
      if (text.includes('UPDATE "agent_turns"')) {
        if (values[3] !== ownerId || values[4] !== 0 || values[5] !== "queued") return { rows: [] }
        turn = { ...turn, status: "in_progress", revision: 1 }
        return { rows: [turn] }
      }
      if (text.includes('INSERT INTO "agent_steps"')) {
        const step: AgentStepRecord = { id: f.stepId, sessionId: f.sessionId, turnId: f.turnId, ordinal: 0, attempt: 1, status: "queued", inputThroughSequence: BigInt(0), consumedInputIds: [], modelProfileSnapshot: { provider: "fixture", model: "fixture-model" }, createdAt: "2026-08-31T00:00:00.000Z" }
        steps.push(step)
        return { rows: [step] }
      }
      if (text.includes('UPDATE "agent_items"')) {
        if (staleItem) return { rows: [] }
        item = { ...item, revision: 1, status: "streaming", phase: "commentary", content: { text: "fixture progress" }, startedAt: "2026-08-31T00:00:00.000Z" }
        return { rows: [item] }
      }
      if (text.includes('SELECT "id" FROM "agent_sessions"')) return { rows: values[1] === ownerId ? [{ id: f.sessionId }] : [] }
      if (text.includes('SELECT "id" FROM "agent_turns"')) return { rows: values[2] === ownerId ? [{ id: f.turnId }] : [] }
      if (text.includes('SELECT "id" FROM "agent_items"')) return { rows: [{ id: f.itemId }] }
      if (text.includes('WHERE "sessionId" = $1 AND "idempotencyKey"')) return { rows: [] }
      if (text.includes('UPDATE "agent_sessions"')) {
        eventSequence += BigInt(1)
        return { rows: [{ eventSequence }] }
      }
      if (text.includes('INSERT INTO "agent_events"')) {
        const event: AgentEventRecord = { id: f.eventId, sessionId: f.sessionId, turnId: f.turnId, itemId: f.itemId, taskId: null, sequence: eventSequence, type: "item.started", actor: "orchestrator", correlationId: "fixture-correlation", causationId: null, idempotencyKey: f.idempotencyKey, payload: { itemId: f.itemId }, createdAt: "2026-08-31T00:00:00.000Z" }
        events.push(event)
        return { rows: [event] }
      }
      if (text.includes('INSERT INTO "agent_outbox"')) {
        if (failOutbox) throw new Error("outbox unavailable")
        return { rows: [] }
      }
      if (text.includes('FROM "agent_turns"')) return { rows: values[2] === ownerId ? [turn] : [] }
      if (text.includes('FROM "agent_steps"')) return { rows: steps }
      if (text.includes('FROM "agent_items"')) return { rows: [item] }
      if (text.includes('FROM "agent_events"')) return { rows: events }
      throw new Error(`unexpected SQL in fake pool: ${text}`)
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, state: { events, get eventSequence() { return eventSequence } } }
}

describe("pg agent repository", () => {
  it("runs the shared fixture with the same projection contract", async () => {
    const f = fixture()
    const fake = makeFakePool()
    const projection = await runRepositoryFixture(createPgAgentStore(fake.pool, f.scope), f)

    expect(projection.turn).toMatchObject({ id: f.turnId, userId: f.scope.userId, revision: 1, status: "in_progress" })
    expect(projection.steps[0]).toMatchObject({ id: f.stepId, inputThroughSequence: BigInt(0) })
    expect(projection.items[0]).toMatchObject({ id: f.itemId, revision: 1, status: "streaming" })
    expect(projection.events[0]).toMatchObject({ id: f.eventId, sequence: BigInt(1) })
    expect(fake.client.query).toHaveBeenCalledWith("SELECT set_config($1, $2, true)", ["app.user_id", f.scope.userId])
  })

  it("rejects a cross-tenant claim and projection", async () => {
    const f = fixture()
    const fake = makeFakePool()
    const store = createPgAgentStore(fake.pool, { userId: "other_user" })
    await expect(store.withUnitOfWork((uow) => uow.claimTurn({ sessionId: f.sessionId, turnId: f.turnId, expectedRevision: 0, expectedStatus: "queued" }))).resolves.toBeNull()
    await expect(store.getProjection({ sessionId: f.sessionId, turnId: f.turnId })).resolves.toBeNull()
  })

  it("rolls back the event sequence and event when outbox creation fails", async () => {
    const f = fixture()
    const fake = makeFakePool(f.scope.userId, true)
    const store = createPgAgentStore(fake.pool, f.scope)
    await expect(store.withUnitOfWork((uow) => uow.appendEvent({ id: f.eventId, sessionId: f.sessionId, turnId: f.turnId, itemId: null, taskId: null, type: "item.started", actor: "orchestrator", correlationId: "c", causationId: null, idempotencyKey: f.idempotencyKey, payload: { itemId: f.itemId }, outboxTopic: "agent.events" }))).rejects.toThrow("outbox unavailable")
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.eventSequence).toBe(BigInt(0))
    expect(fake.client.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("contains no interpolated identifiers in SQL source", () => {
    const source = readFileSync(new URL("./pg-store.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/query\s*\(\s*`[^`]*\$\{/s)
    expect(source).toContain("WHERE \"id\" = $1")
  })

  it("rejects a stale Item revision instead of writing", async () => {
    const f = fixture()
    const fake = makeFakePool(f.scope.userId, false, true)
    const store = createPgAgentStore(fake.pool, f.scope)
    await expect(store.withUnitOfWork((uow) => uow.updateItem({ sessionId: f.sessionId, itemId: f.itemId, expectedRevision: 1, status: "completed", phase: "final_answer", content: { text: "stale" }, startedAt: null, completedAt: null }))).rejects.toMatchObject({ code: "agent_repository_conflict" })
    expect(fake.state.events).toHaveLength(0)
    expect(fake.client.query).toHaveBeenCalledWith("ROLLBACK")
  })
})
