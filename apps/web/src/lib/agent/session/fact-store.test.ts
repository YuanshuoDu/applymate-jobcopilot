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
      create: vi.fn(async (_args: Prisma.AgentEventCreateArgs) => event),
    },
    agentOutbox: {
      create: vi.fn(async (_args: Prisma.AgentOutboxCreateArgs) => ({ id: "outbox_1" })),
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

  it("persists intact typed question routing equally in the event and outbox while redacting answers", async () => {
    const { db, tx } = mockDb()
    const questionId = "70463535-1444-4bba-ae3b-b80578d2dd0a"
    const sessionId = "70463535-1444-4bba-ae3b-b80578d2dd0b"
    const turnId = "70463535-1444-4bba-ae3b-b80578d2dd0c"
    const toolCallId = "70463535-1444-4bba-ae3b-b80578d2dd0d"
    const itemId = `agent-wait:question:${questionId}`
    const waitInput = {
      sessionId, turnId, itemId, taskId: null, type: "question.answered", actor: "user", correlationId: questionId,
      causationId: itemId, idempotencyKey: "question:answer:dedupe", outboxTopic: "agent.session.event",
      payload: { waitKind: "question", waitId: questionId, itemId, turnId, toolCallId, status: "answered",
        nextTurnRevision: 9, answerAvailable: true, answer: "candidate@example.com", note: "Call +1 415 555 0123 or candidate@example.com" },
    } satisfies Parameters<typeof appendAgentEventWithOutbox>[1]

    await appendAgentEventWithOutbox(db, waitInput)

    const eventPayload = tx.agentEvent.create.mock.calls[0]?.[0].data.payload as Record<string, unknown>
    const outboxEnvelope = tx.agentOutbox.create.mock.calls[0]?.[0].data.payload as Record<string, unknown>
    const outboxPayload = outboxEnvelope.payload as Record<string, unknown>
    expect(eventPayload).toMatchObject({ waitKind: "question", waitId: questionId, itemId, turnId, toolCallId, status: "answered" })
    expect(outboxPayload).toEqual(eventPayload)
    expect(eventPayload.answer).toBe("[REDACTED]")
    expect(eventPayload.note).toBe("Call [REDACTED_PHONE] or [REDACTED_EMAIL]")
  })

  it("persists the server-typed task interrupt references in its event and outbox payload", async () => {
    const { db, tx } = mockDb()
    const sessionId = "70463535-1444-4bba-ae3b-b80578d2dd0b"
    const turnId = "70463535-1444-4bba-ae3b-b80578d2dd0c"
    const taskId = "task-70463535-1444-4bba-ae3b-b80578d2dd0a"
    const intentId = "70463535-1444-4bba-ae3b-b80578d2dd0e"
    const taskInput = {
      sessionId, turnId, itemId: null, taskId, type: "task.interrupt.accepted", actor: "user",
      correlationId: turnId, causationId: null,
      idempotencyKey: `agent-task-interrupt-accepted:${sessionId}:interrupt_1`,
      payload: { intentId, taskId, status: "accepted" }, outboxTopic: "agent.session.event",
    } satisfies Parameters<typeof appendAgentEventWithOutbox>[1]

    await appendAgentEventWithOutbox(db, taskInput)

    const eventInput = tx.agentEvent.create.mock.calls[0]?.[0].data
    const outbox = tx.agentOutbox.create.mock.calls[0]?.[0].data.payload as Record<string, unknown>
    expect(eventInput).toMatchObject({ sessionId, turnId, itemId: null, taskId, type: "task.interrupt.accepted",
      actor: "user", correlationId: turnId, causationId: null, payload: { intentId, taskId, status: "accepted" } })
    expect(outbox).toMatchObject({ sessionId, turnId, itemId: null, taskId, type: "task.interrupt.accepted",
      actor: "user", correlationId: turnId, causationId: null, payload: { intentId, taskId, status: "accepted" } })
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
