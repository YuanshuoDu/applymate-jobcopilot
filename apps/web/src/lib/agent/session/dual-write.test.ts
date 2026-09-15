import { describe, expect, it, vi } from "vitest"

import { createDualWriteSession } from "./dual-write"

interface MockDbOptions {
  sessionExists?: boolean
  sessionStatus?: string
  sessionUserId?: string
  itemError?: Error
}

function queryText(query: unknown) {
  return typeof query === "object" && query !== null && "strings" in query
    ? ((query as { strings: readonly string[] }).strings ?? []).join(" ")
    : ""
}

function mockDb(options: MockDbOptions = {}) {
  let sessionStatus = options.sessionStatus ?? "running"
  let rollbackCount = 0
  const tx = {
    agentTurn: {
      findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: "turn_1" }),
      create: vi.fn().mockResolvedValue({ id: "turn_1" }),
      update: vi.fn().mockResolvedValue({ id: "turn_1" }),
    },
    agentItem: {
      create: vi.fn(async () => {
        if (options.itemError) throw options.itemError
        return { id: "item_1" }
      }),
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
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = queryText(query)
      if (sql.includes('FROM "agent_sessions"') && sql.includes('"status" NOT IN')) {
        const owned = options.sessionExists !== false && (options.sessionUserId ?? "user_1") === "user_1"
        const open = !["aborted", "archived"].includes(sessionStatus)
        return owned && open ? [{ id: "session_1" }] : []
      }
      return [{ eventSequence: BigInt(1) }]
    }),
  }
  const db = {
    $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => {
      try {
        return await work(tx)
      } catch (error) {
        rollbackCount += 1
        throw error
      }
    }),
    agentTurn: { findFirst: vi.fn().mockResolvedValue(null) },
  }
  return {
    db,
    tx,
    state: {
      closeSession() { sessionStatus = "aborted" },
      get rollbackCount() { return rollbackCount },
    },
  }
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

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(tx.agentTurn.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "turn_1" },
      data: expect.objectContaining({ status: "completed", finalResponse: "Done" }),
    }))
    expect(db.agentTurn.findFirst).not.toHaveBeenCalled()
  })

  it.each(["aborted", "archived"])("rejects %s sessions before dual-write mutations", async (sessionStatus) => {
    const { db, tx, state } = mockDb({ sessionStatus })

    await expect(createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Closed run",
      source: "user",
    })).rejects.toThrow("does not exist for this user")
    expect(tx.agentTurn.findFirst).not.toHaveBeenCalled()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentItem.create).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })

  it.each([
    ["missing", { sessionExists: false }],
    ["cross-user", { sessionUserId: "another_user" }],
  ] as const)("rejects %s sessions before dual-write mutations", async (_label, options) => {
    const { db, tx, state } = mockDb(options)

    await expect(createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Unauthorized run",
      source: "user",
    })).rejects.toThrow("does not exist for this user")
    expect(tx.agentTurn.findFirst).not.toHaveBeenCalled()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
    expect(tx.agentItem.create).not.toHaveBeenCalled()
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })

  it("rechecks the session before record and rolls back after close", async () => {
    const { db, tx, state } = mockDb()
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Close race",
      source: "user",
    })
    const itemWritesBeforeClose = tx.agentItem.create.mock.calls.length
    state.closeSession()

    await expect(writer.record({
      sessionId: "session_1",
      type: "error",
      speaker: "System",
      title: "Late event",
      body: "Should be rejected",
    })).rejects.toThrow("does not exist for this user")
    expect(tx.agentItem.create).toHaveBeenCalledTimes(itemWritesBeforeClose)
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(tx.agentInput.create).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })

  it("rechecks the session before finalize and rolls back after close", async () => {
    const { db, tx, state } = mockDb()
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Close race",
      source: "user",
    })
    state.closeSession()

    await expect(writer.finalize({ status: "completed", finalResponse: "Late completion" }))
      .rejects.toThrow("does not exist for this user")
    expect(tx.agentTurn.update).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })

  it("rolls back every dual-write mutation when item persistence fails", async () => {
    const itemError = new Error("item unavailable")
    const { db, tx, state } = mockDb({ itemError })
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      goal: "Item failure",
      source: "user",
    })

    await expect(writer.record({
      sessionId: "session_1",
      type: "error",
      speaker: "System",
      title: "Item",
      body: "Fails before event",
    })).rejects.toThrow("item unavailable")
    expect(tx.agentEvent.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(tx.agentTranscriptEvent.create).not.toHaveBeenCalled()
    expect(state.rollbackCount).toBe(1)
  })
})
