import { describe, expect, it, vi } from "vitest"

import { createDualWriteSession } from "./dual-write"

interface MockDbOptions {
  sessionExists?: boolean
  sessionStatus?: string
  sessionUserId?: string
  itemError?: Error
  turnFindFirstResults?: Array<Record<string, unknown> | null>
  itemFindFirstResults?: Array<Record<string, unknown> | null>
  eventFindFirstResults?: Array<Record<string, unknown> | null>
  turnUpdateCount?: number
}

function queryText(query: unknown) {
  return typeof query === "object" && query !== null && "strings" in query
    ? ((query as { strings: readonly string[] }).strings ?? []).join(" ")
    : ""
}

function mockDb(options: MockDbOptions = {}) {
  let sessionStatus = options.sessionStatus ?? "running"
  let rollbackCount = 0
  const turnFindFirst = vi.fn()
  if (options.turnFindFirstResults) {
    const results = [...options.turnFindFirstResults]
    turnFindFirst.mockImplementation(async () => results.shift() ?? null)
  } else {
    turnFindFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "turn_1" })
  }
  const itemFindFirst = vi.fn()
  if (options.itemFindFirstResults) {
    const results = [...options.itemFindFirstResults]
    itemFindFirst.mockImplementation(async () => results.shift() ?? null)
  } else {
    itemFindFirst.mockResolvedValue(null)
  }
  const eventFindFirst = vi.fn()
  if (options.eventFindFirstResults) {
    const results = [...options.eventFindFirstResults]
    eventFindFirst.mockImplementation(async () => results.shift() ?? null)
  } else {
    eventFindFirst.mockResolvedValue(null)
  }
  const tx = {
    agentTurn: {
      findFirst: turnFindFirst,
      create: vi.fn().mockResolvedValue({ id: "turn_1" }),
      update: vi.fn().mockResolvedValue({ id: "turn_1" }),
      updateMany: vi.fn().mockResolvedValue({ count: options.turnUpdateCount ?? 1 }),
    },
    agentItem: {
      create: vi.fn(async () => {
        if (options.itemError) throw options.itemError
        return { id: "item_1" }
      }),
      findFirst: itemFindFirst,
    },
    agentEvent: {
      findFirst: eventFindFirst,
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

  it.each(["queued", "in_progress", "waiting_for_dependency"])("bridges a strict question from %s with one CAS revision", async (status) => {
    const turn = { id: "turn_1", sessionId: "session_1", userId: "user_1", status, revision: 4 }
    const { db, tx } = mockDb({ turnFindFirstResults: [turn, turn] })
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      turnId: "turn_1",
      goal: "Ask for a decision",
      source: "user",
    })

    await writer.record({
      sessionId: "session_1",
      taskId: "task_1",
      type: "approval_request",
      speaker: "Orchestrator",
      title: "Approval Required",
      body: "Choose a path",
      data: { event: "orchestrator_question" },
    }, {
      name: "orchestrator_question",
      payload: {
        id: "question_1",
        stage: "prepare",
        question: "Choose a path",
        options: [{ value: "keep", label: "Keep" }],
      },
    })

    const itemCall = (tx.agentItem.create.mock.calls as unknown[][])[0]?.[0] as { data: Record<string, unknown> }
    const itemContent = itemCall.data.content as Record<string, unknown>
    expect(itemCall.data).toMatchObject({
      id: "agent-wait:question:question_1",
      sessionId: "session_1",
      turnId: "turn_1",
      taskId: "task_1",
      type: "question",
      status: "started",
    })
    expect(itemContent).toMatchObject({
      waitKind: "question",
      questionId: "question_1",
      stage: "prepare",
      question: "Choose a path",
      options: [{ value: "keep", label: "Keep" }],
      sourceEvent: "orchestrator_question",
      sourcePayload: expect.objectContaining({ id: "question_1" }),
    })
    expect((itemContent.sourcePayload as Record<string, unknown>).question).toBe("[REDACTED]")
    expect(tx.agentTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "turn_1", sessionId: "session_1", userId: "user_1", status, revision: 4 }),
      data: expect.objectContaining({ status: "waiting_for_user", revision: { increment: 1 } }),
    }))
    expect(tx.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      itemId: "agent-wait:question:question_1",
      type: "item.started",
      actor: "orchestrator",
      correlationId: "agent-wait:question:question_1",
      causationId: "question_1",
      idempotencyKey: "agent-wait:agent-wait:question:question_1:started",
      payload: expect.objectContaining({
        legacy: expect.objectContaining({ type: "approval_request", body: "Choose a path" }),
        sourceEvent: "orchestrator_question",
        sourcePayload: expect.objectContaining({ id: "question_1" }),
      }),
    }) }))
    expect(tx.agentOutbox.create).toHaveBeenCalledOnce()
    expect(tx.agentTranscriptEvent.create).toHaveBeenCalledOnce()
  })

  it("replays a canonical question without duplicating item, revision, event, outbox, or transcript", async () => {
    const turnInProgress = { id: "turn_1", sessionId: "session_1", userId: "user_1", status: "in_progress", revision: 0 }
    const turnWaiting = { ...turnInProgress, status: "waiting_for_user", revision: 1 }
    const itemId = "agent-wait:question:question_2"
    const raw = {
      name: "orchestrator_question",
      payload: { id: "question_2", stage: "prepare", question: "Choose a path", options: [{ value: "keep", label: "Keep" }] },
    }
    const legacy = {
      sessionId: "session_1",
      type: "approval_request" as const,
      speaker: "Orchestrator",
      title: "Approval Required",
      body: "Choose a path",
      data: {},
    }
    const { db, tx } = mockDb({
      turnFindFirstResults: [turnInProgress, turnInProgress, turnWaiting],
      itemFindFirstResults: [null, {
        id: itemId,
        sessionId: "session_1",
        turnId: "turn_1",
        type: "question",
        status: "started",
        content: {
          questionId: "question_2",
          stage: "prepare",
          question: "Choose a path",
          options: [{ value: "keep", label: "Keep" }],
          sourceEvent: "orchestrator_question",
          sourcePayload: { id: "question_2" },
        },
      }],
      eventFindFirstResults: [null, {
        id: "event_2",
        sessionId: "session_1",
        turnId: "turn_1",
        itemId,
        sequence: BigInt(1),
        type: "item.started",
        actor: "orchestrator",
        payload: {},
      }],
    })
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1",
      userId: "user_1",
      turnId: "turn_1",
      goal: "Replay",
      source: "user",
    })

    await writer.record(legacy, raw)
    await writer.record(legacy, raw)

    expect(tx.agentItem.create).toHaveBeenCalledOnce()
    expect(tx.agentTurn.updateMany).toHaveBeenCalledOnce()
    expect(tx.agentEvent.create).toHaveBeenCalledOnce()
    expect(tx.agentOutbox.create).toHaveBeenCalledOnce()
    expect(tx.agentTranscriptEvent.create).toHaveBeenCalledOnce()
    expect(tx.agentItem.findFirst).toHaveBeenCalledTimes(2)
    expect(tx.agentEvent.findFirst).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["malformed", { payload: { id: "question_3", stage: "prepare", question: "Choose" } }],
    ["extra-key", { payload: { id: "question_4", stage: "prepare", question: "Choose", options: [], extra: true } }],
  ] as const)("uses generic dual-write for a %s question payload", async (_label, payload) => {
    const turn = { id: "turn_1", sessionId: "session_1", userId: "user_1", status: "in_progress", revision: 0 }
    const { db, tx } = mockDb({ turnFindFirstResults: [turn, turn] })
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1", userId: "user_1", turnId: "turn_1", goal: "Malformed", source: "user",
    })

    await writer.record({ sessionId: "session_1", type: "approval_request", speaker: "Orchestrator", title: "Question", body: "Choose", data: {} }, {
      name: "orchestrator_question", payload: payload.payload,
    })

    expect(tx.agentItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "approval_request" }) }))
    expect(tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(tx.agentItem.findFirst).not.toHaveBeenCalled()
  })

  it("uses generic dual-write when explicit-turn question proof is foreign and fails closed when the Turn is missing", async () => {
    const foreignTurn = { id: "turn_foreign", sessionId: "other_session", userId: "other_user", status: "in_progress", revision: 0 }
    const foreign = mockDb({ turnFindFirstResults: [foreignTurn, foreignTurn] })
    const foreignWriter = await createDualWriteSession(foreign.db as never, {
      sessionId: "session_1", userId: "user_1", turnId: "turn_1", goal: "Foreign", source: "user",
    })
    await foreignWriter.record({ sessionId: "session_1", type: "approval_request", speaker: "Orchestrator", title: "Question", body: "Choose", data: {} }, {
      name: "orchestrator_question", payload: { id: "question_5", stage: "prepare", question: "Choose", options: [] },
    })
    expect(foreign.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(foreign.tx.agentItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "approval_request" }) }))

    const missing = mockDb({ turnFindFirstResults: [{ id: "turn_1", sessionId: "session_1", userId: "user_1", status: "in_progress", revision: 0 }, null] })
    const missingWriter = await createDualWriteSession(missing.db as never, {
      sessionId: "session_1", userId: "user_1", turnId: "turn_1", goal: "Missing", source: "user",
    })
    await expect(missingWriter.record({ sessionId: "session_1", type: "approval_request", speaker: "Orchestrator", title: "Question", body: "Choose", data: {} }, {
      name: "orchestrator_question", payload: { id: "question_6", stage: "prepare", question: "Choose", options: [] },
    })).rejects.toThrow("unauthorized agent turn")
    expect(missing.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(missing.tx.agentItem.create).not.toHaveBeenCalled()
  })

  it("does not promote an existing question item with mismatched stored provenance", async () => {
    const turn = { id: "turn_1", sessionId: "session_1", userId: "user_1", status: "in_progress", revision: 0 }
    const conflict = mockDb({
      turnFindFirstResults: [turn, turn],
      itemFindFirstResults: [{
        id: "agent-wait:question:question_8",
        sessionId: "session_1",
        turnId: "turn_1",
        type: "question",
        status: "started",
        content: {
          questionId: "question_8",
          stage: "prepare",
          question: "Choose",
          options: [],
          sourceEvent: "native.question",
          sourcePayload: { id: "question_8" },
        },
      }],
    })
    const writer = await createDualWriteSession(conflict.db as never, {
      sessionId: "session_1", userId: "user_1", turnId: "turn_1", goal: "Conflict", source: "user",
    })
    await writer.record({ sessionId: "session_1", type: "approval_request", speaker: "Orchestrator", title: "Question", body: "Choose", data: {} }, {
      name: "orchestrator_question", payload: { id: "question_8", stage: "prepare", question: "Choose", options: [] },
    })

    expect(conflict.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(conflict.tx.agentItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "approval_request" }) }))
  })

  it("keeps an old shadow dual-write question generic when no explicit Turn is supplied", async () => {
    const { db, tx } = mockDb()
    const writer = await createDualWriteSession(db as never, {
      sessionId: "session_1", userId: "user_1", goal: "Legacy question", source: "user",
    })
    await writer.record({ sessionId: "session_1", type: "approval_request", speaker: "Orchestrator", title: "Question", body: "Choose", data: {} }, {
      name: "orchestrator_question", payload: { id: "question_7", stage: "prepare", question: "Choose", options: [] },
    })
    expect(tx.agentItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "approval_request" }) }))
    expect(tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(tx.agentItem.findFirst).not.toHaveBeenCalled()
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
