import { describe, expect, it, vi } from "vitest"

import type { Prisma, PrismaClient } from "@prisma/client"

import {
  AgentItemRevisionConflictError,
  AgentSessionNotFoundError,
  appendAgentEventWithOutbox,
  updateAgentItemRevision,
} from "./fact-store"

type AgentEventRecord = Prisma.AgentEventGetPayload<{}>

function makeEvent(overrides: Partial<AgentEventRecord> = {}): AgentEventRecord {
  return {
    id: "event_1",
    sessionId: "session_1",
    turnId: "turn_1",
    itemId: null,
    taskId: null,
    sequence: BigInt(7),
    type: "test.event",
    actor: "system",
    correlationId: "correlation_1",
    causationId: null,
    idempotencyKey: "message_1",
    payload: { ok: true },
    createdAt: new Date("2026-08-31T00:00:00.000Z"),
    ...overrides,
  }
}

function mockDb() {
  const event = makeEvent()
  const tx = {
    $queryRaw: vi.fn(async () => [{ eventSequence: BigInt(7) }]),
    agentEvent: {
      findFirst: vi.fn(async () => null as AgentEventRecord | null),
      create: vi.fn(async () => event),
    },
    agentOutbox: {
      create: vi.fn(async () => ({ id: "outbox_1" })),
    },
    agentItem: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  }
  const db = {
    ...tx,
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient

  return { db, tx }
}

const input = {
  sessionId: "session_1",
  turnId: "turn_1",
  type: "agent.message.completed",
  actor: "orchestrator",
  correlationId: "correlation_1",
  idempotencyKey: "message_1",
  payload: { text: "done" },
  outboxTopic: "agent.events",
} satisfies Parameters<typeof appendAgentEventWithOutbox>[1]

describe("agent fact store", () => {
  it("allocates a sequence and creates the event plus outbox together", async () => {
    const { db, tx } = mockDb()
    tx.agentEvent.findFirst.mockResolvedValue(null)

    const result = await appendAgentEventWithOutbox(db, input)

    expect(result).toMatchObject({ duplicate: false, event: { sequence: BigInt(7) } })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.agentEvent.create).toHaveBeenCalledOnce()
    expect(tx.agentOutbox.create).toHaveBeenCalledOnce()
    expect(tx.agentOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        topic: "agent.events",
        aggregateId: "session_1",
        payload: expect.objectContaining({ sequence: "7", eventId: expect.any(String) }),
      }),
    })
  })

  it("persists a bounded session control event with a nullable turn scope", async () => {
    const { db, tx } = mockDb()
    const controlInput = {
      sessionId: "session_1",
      turnId: null,
      itemId: null,
      taskId: null,
      type: "session.paused",
      actor: "system" as const,
      correlationId: "session_1",
      idempotencyKey: "agent-session-control:pause_1",
      payload: {
        sessionId: "session_1",
        operation: "pause",
        previousGate: "open",
        nextGate: "user_paused",
        controlRevision: 1,
        pausedAt: "2026-08-31T00:00:00.000Z",
      },
      outboxTopic: "agent.session.event",
    }

    await expect(appendAgentEventWithOutbox(db, controlInput)).resolves.toMatchObject({ duplicate: false })
    expect(tx.agentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1", turnId: null, itemId: null, taskId: null,
        type: "session.paused", actor: "system", correlationId: "session_1",
      }),
    })
    expect(tx.agentOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        topic: "agent.session.event", aggregateId: "session_1",
        payload: expect.objectContaining({ turnId: null, type: "session.paused" }),
      }),
    })
  })

  it("rejects nullable turn scope for ordinary events and sensitive control payloads", async () => {
    const ordinary = mockDb()
    await expect(appendAgentEventWithOutbox(ordinary.db, { ...input, turnId: null })).rejects.toThrow("require a turnId")
    expect(ordinary.db.$transaction).not.toHaveBeenCalled()

    const control = mockDb()
    await expect(appendAgentEventWithOutbox(control.db, {
      sessionId: "session_1", turnId: null, type: "session.resumed", actor: "system",
      correlationId: "session_1", idempotencyKey: "agent-session-control:resume_1",
      payload: {
        sessionId: "session_1", operation: "resume", previousGate: "user_paused", nextGate: "open",
        controlRevision: 2, pausedAt: null, token: "private",
      }, outboxTopic: "agent.session.event",
    })).rejects.toThrow("invalid payload")
    expect(control.db.$transaction).not.toHaveBeenCalled()
  })

  it("returns the original event for a duplicate idempotency key", async () => {
    const { db, tx } = mockDb()
    const original = makeEvent({ id: "original_event", sequence: BigInt(3) })
    tx.agentEvent.findFirst.mockResolvedValue(original)

    const result = await appendAgentEventWithOutbox(db, input)

    expect(result).toEqual({ event: original, duplicate: true })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("rechecks idempotency inside the transaction before allocating a sequence", async () => {
    const { db, tx } = mockDb()
    const original = makeEvent({ id: "transaction_duplicate", sequence: BigInt(6) })
    tx.agentEvent.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(original)

    const result = await appendAgentEventWithOutbox(db, input)

    expect(result).toEqual({ event: original, duplicate: true })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("re-reads the original event after a concurrent unique-key race", async () => {
    const { db, tx } = mockDb()
    const original = makeEvent({ id: "raced_event", sequence: BigInt(4) })
    tx.agentEvent.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(original)
    const transaction = db.$transaction as unknown as ReturnType<typeof vi.fn>
    transaction.mockRejectedValueOnce({ code: "P2002" })

    const result = await appendAgentEventWithOutbox(db, input)

    expect(result).toEqual({ event: original, duplicate: true })
  })

  it("does not report success when outbox creation fails inside the transaction", async () => {
    const { db, tx } = mockDb()
    tx.agentEvent.findFirst.mockResolvedValue(null)
    tx.agentOutbox.create.mockRejectedValueOnce(new Error("outbox unavailable"))

    await expect(appendAgentEventWithOutbox(db, input)).rejects.toThrow("outbox unavailable")
    expect(tx.agentEvent.create).toHaveBeenCalledOnce()
    expect(tx.agentOutbox.create).toHaveBeenCalledOnce()
  })

  it("fails closed when the sequence allocator cannot find the session", async () => {
    const { db, tx } = mockDb()
    tx.agentEvent.findFirst.mockResolvedValue(null)
    tx.$queryRaw.mockResolvedValue([])

    await expect(appendAgentEventWithOutbox(db, input)).rejects.toBeInstanceOf(AgentSessionNotFoundError)
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
  })

  it("updates an Item only when the expected revision is current", async () => {
    const { db, tx } = mockDb()

    await expect(updateAgentItemRevision(db, {
      itemId: "item_1",
      expectedRevision: 1,
      content: { text: "new" },
      status: "completed",
      phase: "final_answer",
    })).resolves.toEqual({ updated: true, revision: 2 })

    expect(tx.agentItem.updateMany).toHaveBeenCalledWith({
      where: { id: "item_1", revision: 1 },
      data: expect.objectContaining({
        content: { text: "new" },
        status: "completed",
        phase: "final_answer",
        revision: 2,
      }),
    })
  })

  it("rejects a stale Item update", async () => {
    const { db, tx } = mockDb()
    tx.agentItem.updateMany.mockResolvedValue({ count: 0 })

    await expect(updateAgentItemRevision(db, {
      itemId: "item_1",
      expectedRevision: 1,
      content: { text: "stale" },
      status: "completed",
    })).rejects.toBeInstanceOf(AgentItemRevisionConflictError)
  })
})
