import { beforeEach, describe, expect, it, vi } from "vitest"
import { AgentExecutionCancelledError } from "./execution-control"

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  agentRunCreate: vi.fn(),
  executionFindFirst: vi.fn(),
  executionUpdateMany: vi.fn(),
  turnFindFirst: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: mocks.userFindUnique },
    agentRun: { create: mocks.agentRunCreate },
    agentExecution: { findFirst: mocks.executionFindFirst },
    agentTurn: { findFirst: mocks.turnFindFirst },
    $transaction: mocks.transaction,
  },
}))

import { checkpointState, createDurableEventWriter, finishOwnedAttempt, hasDurableRunOwnership, hasExecutionAttemptStatus, isActiveAccount } from "./run-service-helpers"

describe("run service lifecycle helpers", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.userFindUnique.mockResolvedValue({ accountStatus: "active" })
    mocks.executionFindFirst.mockResolvedValue({ id: "execution_1" })
    mocks.turnFindFirst.mockResolvedValue({ id: "turn_1" })
    mocks.executionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work({
      agentExecution: { updateMany: mocks.executionUpdateMany },
    }))
  })

  it("checks the exact running execution attempt", async () => {
    await expect(hasExecutionAttemptStatus({
      id: "execution_1", userId: "user_1", attemptCount: 4, status: "running",
    })).resolves.toBe(true)

    expect(mocks.executionFindFirst).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", status: "running", attemptCount: 4 },
      select: { id: true },
    })
  })

  it("publishes durable events in order only after their recorder writes succeed", async () => {
    let releaseFirst!: () => void
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
    const record = vi.fn()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValueOnce({})
    const published: string[] = []
    const writer = createDurableEventWriter({
      record,
      publish: event => published.push(event),
    })

    writer.emit("role_start", {})
    writer.emit("role_done", {})
    await Promise.resolve()
    expect(record).toHaveBeenCalledTimes(1)
    expect(published).toEqual([])

    releaseFirst()
    await writer.drain()
    expect(record.mock.calls.map(([event]) => event)).toEqual(["role_start", "role_done"])
    expect(published).toEqual(["role_start", "role_done"])
  })

  it("withholds an event when its durable recorder write is rejected", async () => {
    const failure = new Error("Turn stopped")
    const record = vi.fn().mockRejectedValue(failure)
    const publish = vi.fn()
    const onError = vi.fn()
    const writer = createDurableEventWriter({ record, publish, onError })

    writer.emit("role_start", {})
    await writer.drain()

    expect(publish).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it("checks the exact committed attempt and keeps publication bound to an active Turn", async () => {
    await expect(hasDurableRunOwnership({
      id: "execution_1", userId: "user_1", sessionId: "session_1", attemptCount: 4,
      status: "completed", turnId: "turn_1",
    })).resolves.toBe(true)

    expect(mocks.executionFindFirst).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", sessionId: "session_1", status: "completed", attemptCount: 4 },
      select: { id: true },
    })
    expect(mocks.turnFindFirst).toHaveBeenCalledWith({
      where: { id: "turn_1", userId: "user_1", sessionId: "session_1", status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] } },
      select: { id: true },
    })
  })

  it("skips the execution lookup after its request signal aborts", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(hasExecutionAttemptStatus({
      id: "execution_1", userId: "user_1", attemptCount: 4, status: "running", signal: controller.signal,
    })).resolves.toBe(false)
    expect(mocks.executionFindFirst).not.toHaveBeenCalled()
  })

  it("finishes only the claimed running attempt", async () => {
    await expect(finishOwnedAttempt({
      id: "execution_1", userId: "user_1", attemptCount: 4, status: "failed", error: "missing resume",
    })).resolves.toBe(true)

    expect(mocks.executionUpdateMany).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", status: "running", attemptCount: 4 },
      data: { status: "failed", error: "missing resume", completedAt: expect.any(Date) },
    })
  })

  it("rolls back a terminal transition if the request aborts while writing it", async () => {
    const controller = new AbortController()
    let rolledBack = false
    mocks.executionUpdateMany.mockImplementation(async () => {
      controller.abort()
      return { count: 1 }
    })
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      try {
        return await work({ agentExecution: { updateMany: mocks.executionUpdateMany } })
      } catch (error) {
        rolledBack = true
        throw error
      }
    })

    await expect(finishOwnedAttempt({
      id: "execution_1", userId: "user_1", attemptCount: 4, status: "failed", signal: controller.signal,
    })).rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(rolledBack).toBe(true)
  })

  it("parses only known checkpoint states", () => {
    expect(checkpointState({ nextStage: "analyze", scoredJobs: [] })).toMatchObject({ nextStage: "analyze" })
    expect(checkpointState({ nextStage: "unknown" })).toBeUndefined()
    expect(checkpointState(null)).toBeUndefined()
  })

  it("fails closed when account status is unavailable", async () => {
    mocks.userFindUnique.mockRejectedValue(new Error("database unavailable"))
    await expect(isActiveAccount("user_1")).resolves.toBe(false)
  })
})
