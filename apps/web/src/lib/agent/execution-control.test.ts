import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), transaction: vi.fn(),
  queryRaw: vi.fn(), turnUpdateMany: vi.fn(), questionFindFirst: vi.fn(), appendTurnEvent: vi.fn(),
}))
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    agentExecution: { upsert: mocks.upsert, updateMany: mocks.updateMany, findFirst: mocks.findFirst, findUnique: mocks.findUnique },
  },
}))
vi.mock("./session/fact-store", () => ({ appendAgentEventWithOutboxInTransaction: mocks.appendTurnEvent }))

describe("agent execution control plane", () => {
  beforeEach(() => {
    mocks.upsert.mockReset(); mocks.updateMany.mockReset(); mocks.findFirst.mockReset(); mocks.findUnique.mockReset(); mocks.transaction.mockReset()
    mocks.queryRaw.mockReset().mockImplementation(async (query: unknown) => {
      const sql = (query as { strings?: readonly string[] }).strings?.join(" ") ?? ""
      return sql.includes('FROM "agent_sessions"') ? [{ id: "session_1" }] : [{ id: "turn_1", status: "waiting_for_user" }]
    })
    mocks.turnUpdateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.questionFindFirst.mockReset().mockResolvedValue({ id: "agent-question:turn_1:legacy:q1", answer: "continue" })
    mocks.appendTurnEvent.mockReset().mockResolvedValue({ event: { id: "event_1" }, duplicate: false })
    mocks.transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work({
      $queryRaw: mocks.queryRaw,
      agentExecution: { updateMany: mocks.updateMany, findUnique: mocks.findUnique },
      agentTurn: { updateMany: mocks.turnUpdateMany },
      agentRunQuestion: { findFirst: mocks.questionFindFirst },
    }))
  })

  it("creates one durable execution per session", async () => {
    mocks.upsert.mockResolvedValue({ id: "execution_1" })
    const { ensureAgentExecution } = await import("./execution-control")
    await expect(ensureAgentExecution({ userId: "user_1", sessionId: "session_1", autonomous: false })).resolves.toEqual({ id: "execution_1" })
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: "session_1" } }))
  })

  it("claims only queued or paused executions", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.findUnique.mockResolvedValue({ attemptCount: 4 })
    const { claimAgentExecution } = await import("./execution-control")
    await expect(claimAgentExecution({ id: "execution_1", userId: "user_1" })).resolves.toBe(4)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }))
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: "execution_1" }, select: { attemptCount: true } })
  })

  it("claims a dispatched legacy execution only for its exact queued task and expected attempt", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.findUnique.mockResolvedValue({ attemptCount: 5 })
    const { claimAgentExecution } = await import("./execution-control")

    await expect(claimAgentExecution({
      id: "execution_1", userId: "user_1", sessionId: "session_1",
      workerTaskId: "dispatch-job-1", expectedAttemptCount: 4,
    })).resolves.toBe(5)

    const where = mocks.updateMany.mock.calls[0]?.[0].where
    expect(where).toEqual({
      id: "execution_1", userId: "user_1", sessionId: "session_1", workerTaskId: "dispatch-job-1",
      OR: [
        { status: "queued", attemptCount: 4 },
        { status: "running", attemptCount: { gte: 5, lt: Number.MAX_SAFE_INTEGER }, updatedAt: { lt: expect.any(Date) } },
      ],
    })
    expect(mocks.updateMany.mock.calls[0]?.[0].data).toEqual(expect.objectContaining({ status: "running", attemptCount: { increment: 1 } }))
  })

  it("reclaims the same task's repeatedly stale running attempt and increments to fence its old runner", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.findUnique.mockResolvedValue({ attemptCount: 9 })
    const { claimAgentExecution } = await import("./execution-control")

    await expect(claimAgentExecution({
      id: "execution_1", userId: "user_1", sessionId: "session_1",
      workerTaskId: "dispatch-job-1", expectedAttemptCount: 4,
    })).resolves.toBe(9)

    const where = mocks.updateMany.mock.calls[0]?.[0].where
    expect(where).toEqual({
      id: "execution_1", userId: "user_1", sessionId: "session_1", workerTaskId: "dispatch-job-1",
      OR: [
        { status: "queued", attemptCount: 4 },
        { status: "running", attemptCount: { gte: 5, lt: Number.MAX_SAFE_INTEGER }, updatedAt: { lt: expect.any(Date) } },
      ],
    })
    expect(mocks.updateMany.mock.calls[0]?.[0].data).toEqual(expect.objectContaining({
      status: "running", attemptCount: { increment: 1 },
    }))
  })

  it("recognizes only the exact stale-running task across repeated claims at the expected-or-later attempt", async () => {
    const { isStaleExactWorkerAttempt } = await import("./execution-control")
    const now = Date.now()
    const base = { status: "running", attemptCount: 5, workerTaskId: "dispatch-job-1", updatedAt: new Date(0) }

    expect(isStaleExactWorkerAttempt(base, 4, "dispatch-job-1", now)).toBe(true)
    expect(isStaleExactWorkerAttempt({ ...base, attemptCount: 9 }, 4, "dispatch-job-1", now)).toBe(true)
    expect(isStaleExactWorkerAttempt({ ...base, updatedAt: new Date(now) }, 4, "dispatch-job-1", now)).toBe(false)
    expect(isStaleExactWorkerAttempt({ ...base, workerTaskId: "other-job" }, 4, "dispatch-job-1", now)).toBe(false)
    expect(isStaleExactWorkerAttempt({ ...base, attemptCount: 4 }, 4, "dispatch-job-1", now)).toBe(false)
    expect(isStaleExactWorkerAttempt({ ...base, attemptCount: Number.MAX_SAFE_INTEGER }, 4, "dispatch-job-1", now)).toBe(false)
    expect(isStaleExactWorkerAttempt({ ...base, status: "paused" }, 4, "dispatch-job-1", now)).toBe(false)
    expect(isStaleExactWorkerAttempt({ ...base, status: "waiting_for_user" }, 4, "dispatch-job-1", now)).toBe(false)
  })

  it("does not let a stale task or attempt claim a newer dispatch", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const { claimAgentExecution } = await import("./execution-control")

    await expect(claimAgentExecution({
      id: "execution_1", userId: "user_1", sessionId: "session_1",
      workerTaskId: "old-dispatch-job", expectedAttemptCount: 4,
    })).resolves.toBeNull()
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })

  it("fails a terminally rejected legacy dispatch with an exact Turn event", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const { failLegacyTurnBeforeRun } = await import("./execution-control")

    await expect(failLegacyTurnBeforeRun({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1",
      workerTaskId: "dispatch-job-1", expectedAttemptCount: 4,
      turnId: "turn_1", questionId: "agent-question:turn_1:legacy:q1",
      message: "Authorization was revoked.",
    })).resolves.toBe(true)

    const queries = mocks.queryRaw.mock.calls.map(([query]) => (query as { strings?: readonly string[] }).strings?.join(" ") ?? "")
    expect(queries[0]).toContain('FROM "agent_sessions"')
    expect(queries[1]).toContain('FROM "agent_turns"')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "execution_1", userId: "user_1", sessionId: "session_1",
        workerTaskId: "dispatch-job-1",
        OR: [
          { status: "queued", attemptCount: 4 },
          { status: "running", attemptCount: { gte: 5, lt: Number.MAX_SAFE_INTEGER }, updatedAt: { lt: expect.any(Date) } },
        ],
      },
      data: expect.objectContaining({ status: "failed", checkpoint: "failed" }),
    }))
    expect(mocks.turnUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "turn_1", userId: "user_1", sessionId: "session_1", status: "waiting_for_user" },
      data: expect.objectContaining({ status: "failed", error: "Authorization was revoked." }),
    }))
    expect(mocks.appendTurnEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "turn.failed", turnId: "turn_1",
      idempotencyKey: "legacy-turn-preflight-failed:dispatch-job-1",
    }))
  })

  it("terminalizes a stale running exact-task Turn after entitlement revocation", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const { failLegacyTurnBeforeRun } = await import("./execution-control")

    await expect(failLegacyTurnBeforeRun({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1",
      workerTaskId: "dispatch-job-1", expectedAttemptCount: 4,
      turnId: "turn_1", questionId: "agent-question:turn_1:legacy:q1",
      message: "Authorization was revoked.",
    })).resolves.toBe(true)

    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workerTaskId: "dispatch-job-1",
        OR: expect.arrayContaining([expect.objectContaining({
          status: "running", attemptCount: { gte: 5, lt: Number.MAX_SAFE_INTEGER },
          updatedAt: { lt: expect.any(Date) },
        })]),
      }),
    }))
    expect(mocks.turnUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "turn_1", status: "waiting_for_user" }),
      data: expect.objectContaining({ status: "failed" }),
    }))
  })

  it("leaves a fresh running Turn open when terminal preflight loses its stale-owner CAS", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const { failLegacyTurnBeforeRun } = await import("./execution-control")

    await expect(failLegacyTurnBeforeRun({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1",
      workerTaskId: "dispatch-job-1", expectedAttemptCount: 4,
      turnId: "turn_1", questionId: "agent-question:turn_1:legacy:q1", message: "Rejected.",
    })).resolves.toBe(false)
    expect(mocks.turnUpdateMany).not.toHaveBeenCalled()
    expect(mocks.appendTurnEvent).not.toHaveBeenCalled()
    expect(mocks.updateMany.mock.calls[0]?.[0].where.OR).toEqual([
      { status: "queued", attemptCount: 4 },
      { status: "running", attemptCount: { gte: 5, lt: Number.MAX_SAFE_INTEGER }, updatedAt: { lt: expect.any(Date) } },
    ])
  })

  it("does not fail a legacy Turn when Stop interrupted it first", async () => {
    mocks.queryRaw.mockImplementation(async (query: unknown) => {
      const sql = (query as { strings?: readonly string[] }).strings?.join(" ") ?? ""
      return sql.includes('FROM "agent_sessions"') ? [{ id: "session_1" }] : [{ id: "turn_1", status: "interrupted" }]
    })
    const { failLegacyTurnBeforeRun } = await import("./execution-control")

    await expect(failLegacyTurnBeforeRun({
      userId: "user_1", sessionId: "session_1", executionId: "execution_1",
      workerTaskId: "dispatch-job-1", expectedAttemptCount: 4,
      turnId: "turn_1", questionId: "agent-question:turn_1:legacy:q1", message: "Rejected.",
    })).resolves.toBe(false)
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.turnUpdateMany).not.toHaveBeenCalled()
    expect(mocks.appendTurnEvent).not.toHaveBeenCalled()
  })

  it("resets a finished execution when an automation starts another cycle", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    mocks.findFirst.mockResolvedValueOnce({ id: "execution_1", status: "queued" })
    const { ensureAgentExecution } = await import("./execution-control")

    await expect(ensureAgentExecution({ userId: "user_1", sessionId: "session_1", autonomous: true, restartForRun: true })).resolves.toEqual({ id: "execution_1", status: "queued" })
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user_1", sessionId: "session_1", status: { in: ["completed", "failed", "cancelled"] } },
      data: expect.objectContaining({ status: "queued", checkpoint: "scout", workerTaskId: null }),
    }))
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(mocks.updateMany.mock.calls[0][0].data).not.toHaveProperty("attemptCount")
  })

  it("refreshes only the current running attempt inside its side-effect transaction", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    const { refreshAgentExecutionAttempt } = await import("./execution-control")
    const tx = { agentExecution: { updateMany: mocks.updateMany } }

    await expect(refreshAgentExecutionAttempt(tx as never, { id: "execution_1", userId: "user_1", attemptCount: 4 })).resolves.toBe(true)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "execution_1", userId: "user_1", status: "running", attemptCount: 4 },
      data: { updatedAt: expect.any(Date) },
    }))
  })

  it("rejects checkpoints and completion from an older attempt", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const { saveExecutionCheckpoint, finishAgentExecution } = await import("./execution-control")
    await expect(saveExecutionCheckpoint({ id: "execution_1", userId: "user_1", attemptCount: 3, state: { nextStage: "prepare" } })).resolves.toBe(false)
    await expect(finishAgentExecution({ id: "execution_1", userId: "user_1", attemptCount: 3, status: "completed" })).resolves.toBe(false)
    expect(mocks.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ attemptCount: 3 }) }))
    expect(mocks.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ attemptCount: 3, status: "running" }) }))
  })
})
