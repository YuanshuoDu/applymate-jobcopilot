import { describe, expect, it, vi } from "vitest"

import { createDualWriteSession } from "./dual-write"

function mockDb() {
  const tx = {
    agentSession: {
      findFirst: vi.fn().mockResolvedValue({ id: "session_1" }),
    },
    agentTurn: {
      findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: "turn_1" }),
      create: vi.fn().mockResolvedValue({ id: "turn_1" }),
      update: vi.fn().mockResolvedValue({ id: "turn_1" }),
    },
    agentItem: {
      create: vi.fn().mockResolvedValue({ id: "item_1" }),
    },
    agentEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: new Date("2026-08-31T05:00:00.000Z"),
      })),
    },
    agentInput: {
      create: vi.fn().mockResolvedValue({ id: "input_1" }),
    },
    agentOutbox: {
      create: vi.fn().mockResolvedValue({ id: "outbox_1" }),
    },
    agentTranscriptEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "legacy_event_1",
        createdAt: new Date("2026-08-31T05:00:00.000Z"),
        ...data,
      })),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ eventSequence: BigInt(1) }]),
  }
  const db = {
    $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx)),
    agentTurn: { findFirst: vi.fn().mockResolvedValue(null) },
  }
  return { db, tx }
}

describe("legacy/V2 dual writer", () => {
  it("creates one canonical turn and commits legacy transcript plus item/event/outbox in the same transaction", async () => {
    const { db, tx } = mockDb()
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Find EU jobs",
      source: "user",
    })

    const legacy = await writer.record({
      sessionId: "session_1",
      taskId: "task_1",
      type: "orchestrator_plan",
      speaker: "Orchestrator",
      title: "Plan",
      body: "Scout jobs",
      data: { target: "Berlin" },
    })

    expect(writer).toMatchObject({ sessionId: "session_1", turnId: "turn_1", userId: "user_1" })
    expect(legacy).toMatchObject({ type: "orchestrator_plan", body: "Scout jobs", data: { target: "Berlin" } })
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(tx.agentItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ turnId: "turn_1", taskId: "task_1", type: "plan" }) }))
    expect(tx.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ turnId: "turn_1", type: "item.completed", actor: "orchestrator", sequence: BigInt(1) }) }))
    expect(tx.agentOutbox.create).toHaveBeenCalledOnce()
    expect(tx.agentTranscriptEvent.create).toHaveBeenCalledOnce()
  })

  it("preserves unknown pipeline events as opaque V2 facts and a reconstructable legacy row", async () => {
    const { db, tx } = mockDb()
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Run pipeline",
      source: "system",
    })

    await writer.record({
      sessionId: "session_1",
      type: "error",
      speaker: "System",
      title: "Opaque agent event",
      body: "Preserved an unrecognized pipeline event: future_event",
      data: { opaque: true, event: "future_event", payload: { value: 42 } },
    }, { name: "future_event", payload: { value: 42 } })

    expect(tx.agentItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "artifact" }) }))
    expect(tx.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "legacy.opaque", payload: expect.objectContaining({ opaque: true, sourceEvent: "future_event" }) }) }))
    expect(tx.agentTranscriptEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "error", data: expect.objectContaining({ __agentHarnessV2: expect.objectContaining({ opaque: true }) }) }) }))
  })

  it("materializes a chat message as a durable V2 input tied to its Turn", async () => {
    const { db, tx } = mockDb()
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Chat",
      source: "user",
    })

    await writer.record({
      sessionId: "session_1",
      type: "user_message",
      speaker: "You",
      title: "Message",
      body: "Find Dublin jobs",
    })

    expect(tx.agentInput.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ targetTurnId: "turn_1", userId: "user_1", delivery: "follow_up", acceptedSequence: BigInt(1) }),
    }))
  })

  it("maps terminal status without creating a second session", async () => {
    const { db, tx } = mockDb()
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Run automation",
      source: "automation",
    })

    await writer.finalize({ status: "completed", finalResponse: "Done" })

    expect(tx.agentSession.findFirst).toHaveBeenCalled()
    expect(tx.agentTurn.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "turn_1" },
      data: expect.objectContaining({ status: "completed", finalResponse: "Done" }),
    }))
    expect(db.agentTurn.findFirst).not.toHaveBeenCalled()
  })
})
