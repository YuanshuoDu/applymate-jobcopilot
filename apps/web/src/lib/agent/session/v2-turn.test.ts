import { describe, expect, it, vi } from "vitest"

import { ensureV2Turn } from "./v2-turn"

interface MockDbOptions {
  activeTurn?: { id: string } | null
  fallbackTurn?: { id: string } | null
  sessionExists?: boolean
  sessionStatus?: string
  sessionUserId?: string
  createError?: unknown
  closeAfterCreate?: boolean
}

function queryText(query: unknown) {
  return typeof query === "object" && query !== null && "strings" in query
    ? ((query as { strings: readonly string[] }).strings ?? []).join(" ")
    : ""
}

function mockDb(options: MockDbOptions = {}) {
  let transactionCalls = 0
  let sessionStatus = options.sessionStatus ?? "running"
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      if (!queryText(query).includes('FROM "agent_sessions"')) return []
      const owned = options.sessionExists !== false && (options.sessionUserId ?? "user_1") === "user_1"
      const closed = ["aborted", "archived"].includes(sessionStatus)
      return owned && !closed ? [{ id: "session_1" }] : []
    }),
    agentTurn: {
      findFirst: vi.fn(async () => transactionCalls > 1
        ? (options.fallbackTurn ?? options.activeTurn ?? null)
        : (options.activeTurn ?? null)),
      create: vi.fn(async () => {
        if (options.createError) {
          if (options.closeAfterCreate) sessionStatus = "aborted"
          throw options.createError
        }
        return { id: "turn_new" }
      }),
    },
  }
  const db = {
    $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => {
      transactionCalls += 1
      return work(tx)
    }),
    agentTurn: { findFirst: vi.fn().mockResolvedValue(options.fallbackTurn ?? options.activeTurn ?? null) },
  }
  return { db, tx }
}

const input = {
  sessionId: "session_1",
  userId: "user_1",
  goal: "Find Berlin jobs",
  source: "user" as const,
}

describe("ensureV2Turn", () => {
  it("locks the open session before reusing the active root Turn", async () => {
    const { db, tx } = mockDb({ activeTurn: { id: "turn_active" } })

    await expect(ensureV2Turn(db as never, input)).resolves.toEqual({
      sessionId: "session_1",
      turnId: "turn_active",
      userId: "user_1",
    })
    expect(tx.$queryRaw).toHaveBeenCalledBefore(tx.agentTurn.findFirst)
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
  })

  it.each(["paused", "waiting_for_user"])("accepts an open \"%s\" session", async (sessionStatus) => {
    const { db, tx } = mockDb({ sessionStatus })

    await expect(ensureV2Turn(db as never, { ...input, source: "automation" })).resolves.toMatchObject({
      sessionId: "session_1",
      turnId: "turn_new",
      userId: "user_1",
    })
    expect(tx.agentTurn.create).toHaveBeenCalled()
  })

  it("creates a fresh in-progress Turn after terminal history", async () => {
    const { db, tx } = mockDb()

    await expect(ensureV2Turn(db as never, input)).resolves.toMatchObject({
      sessionId: "session_1",
      turnId: "turn_new",
      userId: "user_1",
    })
    expect(tx.agentTurn.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        userId: "user_1",
        status: "in_progress",
        source: "user",
        input: { goal: "Find Berlin jobs" },
        startedAt: expect.any(Date),
      }),
      select: { id: true },
    })
  })

  it.each(["aborted", "archived"])("rejects a %s session before reading or creating a Turn", async (sessionStatus) => {
    const { db, tx } = mockDb({ sessionStatus })

    await expect(ensureV2Turn(db as never, input)).rejects.toThrow("does not exist for this user")
    expect(tx.agentTurn.findFirst).not.toHaveBeenCalled()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
  })

  it.each([
    ["missing", { sessionExists: false }],
    ["cross-user", { sessionUserId: "another_user" }],
  ] as const)("rejects a %s session without Turn writes", async (_label, options) => {
    const { db, tx } = mockDb(options)

    await expect(ensureV2Turn(db as never, input)).rejects.toThrow("does not exist for this user")
    expect(tx.agentTurn.findFirst).not.toHaveBeenCalled()
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
  })

  it("recovers a concurrent active Turn after the partial unique index rejects creation", async () => {
    const uniqueError = Object.assign(new Error("active root conflict"), { code: "P2002" })
    const { db, tx } = mockDb({ createError: uniqueError, fallbackTurn: { id: "turn_raced" } })

    await expect(ensureV2Turn(db as never, input)).resolves.toMatchObject({ turnId: "turn_raced" })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(db.agentTurn.findFirst).not.toHaveBeenCalled()
  })

  it("does not reuse a Turn when the session closes during P2002 recovery", async () => {
    const uniqueError = Object.assign(new Error("active root conflict"), { code: "P2002" })
    const { db, tx } = mockDb({ createError: uniqueError, closeAfterCreate: true, fallbackTurn: { id: "turn_closed" } })

    await expect(ensureV2Turn(db as never, input)).rejects.toThrow("does not exist for this user")
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(tx.agentTurn.findFirst).toHaveBeenCalledTimes(1)
  })

})
