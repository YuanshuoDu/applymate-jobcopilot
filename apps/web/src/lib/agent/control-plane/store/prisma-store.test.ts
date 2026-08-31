import { describe, expect, it, vi } from "vitest"

import type { PrismaClient } from "@prisma/client"
import {
  runRepositoryFixture,
  type AgentEventRecord,
  type AgentItemRecord,
  type AgentStepRecord,
  type AgentTurnRecord,
  type RepositoryFixture,
} from "@jobcopilot/agent-protocol"

import { createPrismaAgentStore } from "./prisma-store"

type Where = Record<string, unknown>

function whereOf(args: unknown): Where {
  return ((args as { where?: Where }).where ?? {})
}

function dataOf(args: unknown): Where {
  return ((args as { data: Where }).data)
}

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

function makeFakeDb(ownerId = "user_fixture", failOutbox = false, rawMode: "fixture" | "append" | "item" | "stale" = "fixture") {
  const f = fixture()
  let turn: AgentTurnRecord = {
    id: f.turnId,
    sessionId: f.sessionId,
    userId: ownerId,
    source: "user",
    status: "queued",
    revision: 0,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  }
  let item: AgentItemRecord = {
    id: f.itemId,
    sessionId: f.sessionId,
    turnId: f.turnId,
    stepId: null,
    taskId: null,
    type: "agent_message",
    status: "started",
    phase: "commentary",
    revision: 0,
    content: { text: "initial" },
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  }
  const steps: AgentStepRecord[] = []
  const events: AgentEventRecord[] = []
  let eventSequence = BigInt(0)
  let rawCalls = 0

  const tx = {
    $queryRaw: vi.fn(async () => {
      rawCalls += 1
      if (rawMode === "stale") return []
      if (rawMode !== "append" && rawCalls === 1) {
        item = { ...item, revision: 1, status: "streaming", phase: "commentary", content: { text: "fixture progress" }, startedAt: "2026-08-31T00:00:00.000Z" }
        return [item]
      }
      if (rawMode === "item") return [item]
      if (rawMode === "append" && rawCalls === 1) return ownerId === f.scope.userId ? [{ id: f.sessionId }] : []
      if (rawMode === "fixture" && rawCalls === 2) return ownerId === f.scope.userId ? [{ id: f.sessionId }] : []
      eventSequence += BigInt(1)
      return [{ eventSequence }]
    }),
    agentTurn: {
      updateMany: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        if (where.userId !== ownerId || where.id !== turn.id || where.revision !== turn.revision || where.status !== turn.status) return { count: 0 }
        turn = { ...turn, status: "in_progress", revision: turn.revision + 1 }
        return { count: 1 }
      }),
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        return where.userId === ownerId && where.id === turn.id && where.sessionId === turn.sessionId ? turn : null
      }),
    },
    agentSession: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        return where.id === f.sessionId && where.userId === ownerId ? { id: f.sessionId } : null
      }),
    },
    agentStep: {
      create: vi.fn(async (args: unknown) => {
        const data = dataOf(args) as unknown as Omit<AgentStepRecord, "createdAt">
        const step: AgentStepRecord = { ...data, createdAt: "2026-08-31T00:00:00.000Z" }
        steps.push(step)
        return step
      }),
      findMany: vi.fn(async () => steps),
    },
    agentItem: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        return where.id === item.id && where.sessionId === item.sessionId && where.turnId === item.turnId ? item : null
      }),
      findMany: vi.fn(async () => [item]),
    },
    agentEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = whereOf(args)
        return events.find((event) => event.sessionId === where.sessionId && event.idempotencyKey === where.idempotencyKey) ?? null
      }),
      create: vi.fn(async (args: unknown) => {
        const data = dataOf(args) as unknown as AgentEventRecord
        const event: AgentEventRecord = { ...data, createdAt: "2026-08-31T00:00:00.000Z" }
        events.push(event)
        return event
      }),
      findMany: vi.fn(async () => events),
    },
    agentOutbox: {
      create: vi.fn(async () => {
        if (failOutbox) throw new Error("outbox unavailable")
        return { id: "outbox_fixture" }
      }),
    },
  }

  const transaction = vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
    const before = { turn, item, eventSequence, steps: [...steps], events: [...events] }
    try {
      return await callback(tx)
    } catch (error: unknown) {
      turn = before.turn
      item = before.item
      eventSequence = before.eventSequence
      steps.splice(0, steps.length, ...before.steps)
      events.splice(0, events.length, ...before.events)
      throw error
    }
  })
  const db = { $transaction: transaction } as unknown as PrismaClient
  return { db, tx, transaction, state: { get turn() { return turn }, get item() { return item }, events } }
}

describe("Prisma agent repository", () => {
  it("runs the shared fixture with the same projection contract", async () => {
    const f = fixture()
    const fake = makeFakeDb()
    const projection = await runRepositoryFixture(createPrismaAgentStore(fake.db, f.scope), f)

    expect(projection.turn).toMatchObject({ id: f.turnId, userId: f.scope.userId, revision: 1, status: "in_progress" })
    expect(projection.steps[0]).toMatchObject({ id: f.stepId, inputThroughSequence: BigInt(0) })
    expect(projection.items[0]).toMatchObject({ id: f.itemId, revision: 1, status: "streaming" })
    expect(projection.events[0]).toMatchObject({ id: f.eventId, sequence: BigInt(1) })
  })

  it("injects tenant ownership into compare-and-set mutations", async () => {
    const f = fixture()
    const fake = makeFakeDb()
    const store = createPrismaAgentStore(fake.db, { userId: "other_user" })
    const claimed = await store.withUnitOfWork((uow) => uow.claimTurn({ sessionId: f.sessionId, turnId: f.turnId, expectedRevision: 0, expectedStatus: "queued" }))

    expect(claimed).toBeNull()
    expect(fake.tx.agentSession.findFirst).toHaveBeenCalledWith({ where: { id: f.sessionId, userId: "other_user" }, select: { id: true } })
    expect(fake.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    await expect(store.getProjection({ sessionId: f.sessionId, turnId: f.turnId })).resolves.toBeNull()
  })

  it("propagates transaction failures and leaves no event in the transaction state", async () => {
    const f = fixture()
    const fake = makeFakeDb(f.scope.userId, true, "append")
    const store = createPrismaAgentStore(fake.db, f.scope)

    await expect(store.withUnitOfWork(async (uow) => {
      await uow.appendEvent({ id: f.eventId, sessionId: f.sessionId, turnId: f.turnId, itemId: null, taskId: null, type: "item.started", actor: "orchestrator", correlationId: "c", causationId: null, idempotencyKey: f.idempotencyKey, payload: { itemId: f.itemId }, outboxTopic: "agent.events" })
    })).rejects.toThrow("outbox unavailable")
    expect(fake.state.events).toHaveLength(0)
    expect(fake.transaction).toHaveBeenCalledOnce()
  })

  it("uses Prisma parameterized SQL for the atomic Item revision update", async () => {
    const f = fixture()
    const fake = makeFakeDb()
    const store = createPrismaAgentStore(fake.db, f.scope)
    await store.withUnitOfWork((uow) => uow.updateItem({ sessionId: f.sessionId, itemId: f.itemId, expectedRevision: 0, status: "streaming", phase: "commentary", content: { text: "fixture progress" }, startedAt: "2026-08-31T00:00:00.000Z", completedAt: null }))

    expect(fake.tx.$queryRaw).toHaveBeenCalledOnce()
    expect(fake.state.item.revision).toBe(1)
  })

  it("rejects a stale Item revision instead of writing", async () => {
    const f = fixture()
    const fake = makeFakeDb(f.scope.userId, false, "stale")
    const store = createPrismaAgentStore(fake.db, f.scope)
    await expect(store.withUnitOfWork((uow) => uow.updateItem({ sessionId: f.sessionId, itemId: f.itemId, expectedRevision: 1, status: "completed", phase: "final_answer", content: { text: "stale" }, startedAt: null, completedAt: null }))).rejects.toMatchObject({ code: "agent_repository_conflict" })
    expect(fake.state.item.revision).toBe(0)
  })
})
