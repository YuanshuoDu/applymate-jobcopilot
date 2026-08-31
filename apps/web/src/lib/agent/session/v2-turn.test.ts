import { describe, expect, it, vi } from "vitest"

import { ensureV2Turn } from "./v2-turn"

interface MockDbOptions {
  activeTurn?: { id: string } | null
  session?: { id: string } | null
  createError?: unknown
}

function mockDb({ activeTurn = null, session = { id: "session_1" }, createError }: MockDbOptions = {}) {
  const tx = {
    agentSession: { findFirst: vi.fn().mockResolvedValue(session) },
    agentTurn: {
      findFirst: vi.fn().mockResolvedValue(activeTurn),
      create: vi.fn().mockResolvedValue({ id: "turn_new" }),
    },
  }
  const db = {
    $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => {
      if (createError) throw createError
      return work(tx)
    }),
    agentTurn: { findFirst: vi.fn().mockResolvedValue(activeTurn) },
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
  it("reuses the active root Turn", async () => {
    const { db, tx } = mockDb({ activeTurn: { id: "turn_active" } })

    await expect(ensureV2Turn(db as never, input)).resolves.toEqual({
      sessionId: "session_1",
      turnId: "turn_active",
      userId: "user_1",
    })
    expect(tx.agentTurn.create).not.toHaveBeenCalled()
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

  it("rejects a session that is not owned by the caller", async () => {
    const { db } = mockDb({ session: null })

    await expect(ensureV2Turn(db as never, input)).rejects.toThrow("does not exist for this user")
  })

  it("recovers a concurrent active Turn after the partial unique index rejects creation", async () => {
    const uniqueError = Object.assign(new Error("active root conflict"), { code: "P2002" })
    const { db } = mockDb({ createError: uniqueError, activeTurn: { id: "turn_raced" } })

    await expect(ensureV2Turn(db as never, input)).resolves.toMatchObject({ turnId: "turn_raced" })
    expect(db.agentTurn.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1", userId: "user_1" }),
    }))
  })
})
