import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentSessionDb } from "./repository"

const mocks = vi.hoisted(() => ({ createDualWriteSession: vi.fn() }))
vi.mock("./dual-write", () => ({ createDualWriteSession: mocks.createDualWriteSession }))

import { assertExistingSessionAvailable, createRunSessionActivation } from "./run-recorder-activation"

function mockDb(options: {
  sessionStatus?: string
  updateCount?: number
  executionUpdateCount?: number
  activeTurn?: { id: string; status?: string; input?: unknown } | null
  answeredQuestion?: boolean
} = {}) {
  let rollbacks = 0
  const agentSession = {
    findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => ({
      id: where.id,
      status: options.sessionStatus ?? "paused",
    })),
    updateMany: vi.fn(async () => ({ count: options.updateCount ?? 1 })),
  }
  const agentExecution = { updateMany: vi.fn(async () => ({ count: options.executionUpdateCount ?? 1 })) }
  const agentTurn = {
    create: vi.fn(async () => ({ id: "turn_new" })),
    findFirst: vi.fn(async () => options.activeTurn ?? null),
  }
  const agentRunQuestion = { findFirst: vi.fn(async () => options.answeredQuestion ? { id: "legacy_q1" } : null) }
  const $queryRaw = vi.fn(async (query: unknown) => {
    const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ")
    return sql.includes('FROM "agent_sessions"') ? [{ id: "session_1" }]
      : options.activeTurn ? [{ id: options.activeTurn.id, status: options.activeTurn.status ?? "in_progress", input: options.activeTurn.input ?? {} }] : []
  })
  const transaction = vi.fn(async (work: (tx: never) => Promise<unknown>) => {
    try {
      return await work({ agentSession, agentExecution, agentTurn, agentRunQuestion, $queryRaw } as never)
    } catch (error) {
      rollbacks += 1
      throw error
    }
  })
  const db = { agentSession, agentExecution, $transaction: transaction } as unknown as AgentSessionDb
  return { db, agentSession, agentExecution, agentTurn, agentRunQuestion, transaction, $queryRaw, rollbackCount: () => rollbacks }
}

function input(overrides: Partial<Parameters<typeof createRunSessionActivation>[1]> = {}) {
  return {
    userId: "user_1",
    sessionId: "session_1",
    goal: "Claimed run",
    dualWrite: true,
    deferActivation: true,
    reopenSession: true,
    ...overrides,
  }
}

describe("run recorder activation", () => {
  beforeEach(() => mocks.createDualWriteSession.mockReset())

  it("waits for explicit activation before reopening or creating a V2 projection", async () => {
    const { db, agentSession } = mockDb()
    mocks.createDualWriteSession.mockResolvedValue({ record: vi.fn(), finalize: vi.fn() })
    const activation = createRunSessionActivation(db, input())

    expect(activation.isActivated()).toBe(false)
    expect(agentSession.updateMany).not.toHaveBeenCalled()
    expect(mocks.createDualWriteSession).not.toHaveBeenCalled()

    await activation.activate()

    expect(mocks.createDualWriteSession).toHaveBeenCalledOnce()
    expect(agentSession.updateMany).toHaveBeenCalledOnce()
    expect(mocks.createDualWriteSession).toHaveBeenCalledBefore(agentSession.updateMany)
    expect(activation.isActivated()).toBe(true)
  })

  it("keeps the legacy session closed until deferred V2 projection is ready", async () => {
    const { db, agentSession } = mockDb({ sessionStatus: "waiting_for_user" })
    let resolveProjection!: (projection: { record: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> }) => void
    mocks.createDualWriteSession.mockReturnValue(new Promise(resolve => {
      resolveProjection = resolve
    }))
    const activation = createRunSessionActivation(db, input())

    const pendingActivation = activation.activate()
    await Promise.resolve()
    expect(mocks.createDualWriteSession).toHaveBeenCalledOnce()
    expect(agentSession.updateMany).not.toHaveBeenCalled()
    expect(activation.isActivated()).toBe(false)

    resolveProjection({ record: vi.fn(), finalize: vi.fn() })
    await pendingActivation
    expect(agentSession.updateMany).toHaveBeenCalledOnce()
    expect(activation.isActivated()).toBe(true)
  })

  it("does not reopen the legacy session if execution ownership is lost during projection", async () => {
    const { db, agentSession } = mockDb({ sessionStatus: "waiting_for_user" })
    const controller = new AbortController()
    mocks.createDualWriteSession.mockImplementation(async () => {
      controller.abort()
      return { record: vi.fn(), finalize: vi.fn() }
    })
    const activation = createRunSessionActivation(db, input())

    await expect(activation.activate({
      executionAttempt: { id: "execution_1", attemptCount: 7 },
      signal: controller.signal,
      assertCurrent: async () => true,
    })).resolves.toBe(false)

    expect(mocks.createDualWriteSession).toHaveBeenCalledOnce()
    expect(agentSession.updateMany).not.toHaveBeenCalled()
    expect(activation.isActivated()).toBe(false)
  })

  it("does not reopen the session when the transactional execution fence loses", async () => {
    const { db, agentSession, agentExecution, transaction } = mockDb({ sessionStatus: "waiting_for_user", executionUpdateCount: 0 })
    mocks.createDualWriteSession.mockResolvedValue({ record: vi.fn(), finalize: vi.fn() })
    const activation = createRunSessionActivation(db, input())
    const assertCurrent = vi.fn().mockResolvedValue(true)

    await expect(activation.activate({
      executionAttempt: { id: "execution_1", attemptCount: 7 },
      assertCurrent,
    })).resolves.toBe(false)

    expect(transaction).toHaveBeenCalledOnce()
    expect(agentExecution.updateMany).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", status: "running", attemptCount: 7 },
      data: { updatedAt: expect.any(Date) },
    })
    expect(agentSession.updateMany).not.toHaveBeenCalled()
    expect(activation.isActivated()).toBe(false)
  })

  it("does not reopen a session when its ownership check loses", async () => {
    const { db, agentSession } = mockDb({ sessionStatus: "waiting_for_user", updateCount: 0 })
    mocks.createDualWriteSession.mockResolvedValue({ record: vi.fn(), finalize: vi.fn() })
    const activation = createRunSessionActivation(db, input())

    await expect(activation.activate()).rejects.toThrow("does not exist for this user")

    expect(mocks.createDualWriteSession).toHaveBeenCalledOnce()
    expect(agentSession.updateMany).toHaveBeenCalledOnce()
    expect(activation.isActivated()).toBe(false)
  })

  it("validates an existing session without changing its lifecycle", async () => {
    const { db, agentSession } = mockDb({ sessionStatus: "waiting_for_user" })

    await expect(assertExistingSessionAvailable(db, { sessionId: "session_1", userId: "user_1" })).resolves.toBeUndefined()

    expect(agentSession.findFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" },
      select: { id: true, status: true },
    })
    expect(agentSession.updateMany).not.toHaveBeenCalled()
  })

  it.each(["aborted", "archived"])("rejects a %s session before activation", async status => {
    const { db, agentSession } = mockDb({ sessionStatus: status })
    agentSession.findFirst.mockResolvedValue({ id: "session_1", status })

    await expect(assertExistingSessionAvailable(db, { sessionId: "session_1", userId: "user_1" }))
      .rejects.toThrow("does not exist for this user")
    expect(agentSession.updateMany).not.toHaveBeenCalled()
  })

  it("preserves eager existing-session lifecycle for callers without deferral", async () => {
    const { db, agentSession } = mockDb({ sessionStatus: "paused" })
    mocks.createDualWriteSession.mockResolvedValue({ record: vi.fn(), finalize: vi.fn() })
    const activation = createRunSessionActivation(db, input({ deferActivation: false }))

    await activation.activate()

    expect(agentSession.updateMany).toHaveBeenCalledBefore(mocks.createDualWriteSession)
    expect(activation.isActivated()).toBe(true)
  })

  it("does not reopen the Session if projection construction fails after Turn creation", async () => {
    const { db, agentSession, agentTurn, transaction, rollbackCount } = mockDb()
    mocks.createDualWriteSession.mockRejectedValueOnce(new Error("projection setup failed"))
    const activation = createRunSessionActivation(db, input({ ensureTurn: true }))

    await expect(activation.activate({
      executionAttempt: { id: "execution_1", attemptCount: 7 },
      assertCurrent: async () => true,
    })).rejects.toThrow("projection setup failed")

    expect(transaction).toHaveBeenCalledOnce()
    expect(agentTurn.create).toHaveBeenCalledOnce()
    expect(agentSession.updateMany).not.toHaveBeenCalled()
    expect(rollbackCount()).toBe(1)
    expect(activation.isActivated()).toBe(false)
  })

  it("stores raw legacy question provenance on its newly created continuation Turn", async () => {
    const { db, agentTurn, $queryRaw, agentRunQuestion } = mockDb({ answeredQuestion: true })
    mocks.createDualWriteSession.mockResolvedValue({ record: vi.fn(), finalize: vi.fn() })
    const activation = createRunSessionActivation(db, input({
      dualWrite: false, ensureTurn: true, legacyResumeQuestionId: "legacy_q1",
    }))

    await expect(activation.activate({
      executionAttempt: { id: "execution_1", attemptCount: 7 },
      assertCurrent: async () => true,
    })).resolves.toBe(true)

    expect(agentRunQuestion.findFirst).toHaveBeenCalledWith({
      where: { id: "legacy_q1", userId: "user_1", runId: "session_1", answer: { not: null } },
      select: { id: true },
    })
    expect(agentTurn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ input: { goal: "Claimed run", legacyResumeQuestionId: "legacy_q1" } }),
    }))
    expect($queryRaw.mock.calls.map(([query]) => ((query as { strings?: readonly string[] }).strings ?? []).join(" ")))
      .toEqual(expect.arrayContaining([expect.stringContaining('FROM "agent_sessions"'), expect.stringContaining('FROM "agent_turns"')]))
  })

  it("refuses to attach a raw legacy answer to a later unrelated active Turn", async () => {
    const { db, agentSession, agentTurn, agentExecution } = mockDb({
      activeTurn: { id: "later_turn", status: "in_progress", input: { goal: "New request" } },
      answeredQuestion: true,
    })
    mocks.createDualWriteSession.mockResolvedValue({ record: vi.fn(), finalize: vi.fn() })
    const activation = createRunSessionActivation(db, input({
      dualWrite: false, ensureTurn: true, legacyResumeQuestionId: "legacy_q1",
    }))

    await expect(activation.activate({
      executionAttempt: { id: "execution_1", attemptCount: 7 },
      assertCurrent: async () => true,
    })).resolves.toBe(false)

    expect(agentTurn.create).not.toHaveBeenCalled()
    expect(agentSession.updateMany).not.toHaveBeenCalled()
    expect(agentExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "execution_1", sessionId: "session_1", attemptCount: 7, status: "running" }),
      data: expect.objectContaining({ status: "failed", checkpoint: "failed" }),
    }))
    expect(activation.isActivated()).toBe(false)
  })

  it("reuses the Turn only when it carries the same raw legacy question provenance", async () => {
    const { db, agentTurn, agentRunQuestion } = mockDb({
      activeTurn: { id: "legacy_resume_turn", status: "in_progress", input: { legacyResumeQuestionId: "legacy_q1" } },
      answeredQuestion: true,
    })
    mocks.createDualWriteSession.mockResolvedValue({ record: vi.fn(), finalize: vi.fn() })
    const activation = createRunSessionActivation(db, input({
      dualWrite: false, ensureTurn: true, legacyResumeQuestionId: "legacy_q1",
    }))

    await expect(activation.activate({
      executionAttempt: { id: "execution_1", attemptCount: 8 },
      assertCurrent: async () => true,
    })).resolves.toBe(true)

    expect(agentRunQuestion.findFirst).toHaveBeenCalledOnce()
    expect(agentTurn.create).not.toHaveBeenCalled()
    expect(mocks.createDualWriteSession).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ legacyResumeQuestionId: "legacy_q1" }), expect.anything(),
      { sessionId: "session_1", userId: "user_1", turnId: "legacy_resume_turn" },
    )
  })
})
