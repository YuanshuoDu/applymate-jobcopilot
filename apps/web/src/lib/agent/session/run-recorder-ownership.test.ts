import { describe, expect, it, vi } from "vitest"
import { createRunRecorderWriteContext, withRunRecorderTerminalOwnership, withRunRecorderWriteOwnership } from "./run-recorder-ownership"

function fakeDb(turnStatus = "in_progress", executionCount = 1) {
  const order: string[] = []
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      const sql = strings.join(" ")
      order.push(sql.includes('FROM "agent_sessions"') ? "session-lock" : "turn-lock")
      return sql.includes('FROM "agent_sessions"') ? [{ id: "session_1" }] : [{ id: "turn_1", status: turnStatus }]
    }),
    agentExecution: {
      updateMany: vi.fn(async () => { order.push("execution-lock"); return { count: executionCount } }),
      findFirst: vi.fn(async () => ({ status: "running" })),
    },
    agentTurn: { updateMany: vi.fn(async () => { order.push("turn-terminal"); return { count: 1 } }) },
  }
  const db = { $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(tx)) }
  return { db, tx, order }
}

const owner = {
  turnId: "turn_1",
  executionAttempt: { id: "execution_1", userId: "user_1", attemptCount: 3 },
  terminalStatus: "completed" as const,
}

describe("run recorder ownership transactions", () => {
  it("terminalizes only after locking Session, exact active Turn, and exact attempt", async () => {
    const { db, tx, order } = fakeDb()
    const write = vi.fn(async () => { order.push("session-write") })

    await expect(withRunRecorderTerminalOwnership(db as never, {
      sessionId: "session_1", userId: "user_1", owner,
      v2Finalize: { status: "completed", finalResponse: "done", error: null },
    }, write)).resolves.toBe(true)

    expect(order).toEqual(["session-lock", "turn-lock", "execution-lock", "turn-terminal", "session-write"])
    expect(tx.agentExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "execution_1", userId: "user_1", sessionId: "session_1", attemptCount: 3, status: "completed" }),
    }))
  })

  it("pauses execution, Turn, and legacy Session state in one owner transaction", async () => {
    const { db, tx, order } = fakeDb()
    const write = vi.fn(async () => { order.push("session-paused") })

    await expect(withRunRecorderTerminalOwnership(db as never, {
      sessionId: "session_1", userId: "user_1",
      owner: { ...owner, terminalStatus: "running", executionTransitionTo: "waiting_for_user" },
      v2Finalize: { status: "waiting_for_user", finalResponse: "Waiting for answer", error: null },
    }, write)).resolves.toBe(true)

    expect(order).toEqual(["session-lock", "turn-lock", "execution-lock", "turn-terminal", "session-paused"])
    expect(tx.agentExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "running", attemptCount: 3 }),
      data: expect.objectContaining({ status: "waiting_for_user", completedAt: null }),
    }))
    expect(write).toHaveBeenCalledOnce()
  })

  it("does not run a task/transcript write after Stop interrupted its exact Turn", async () => {
    const { db, tx } = fakeDb("interrupted")
    const write = vi.fn()

    await expect(withRunRecorderWriteOwnership(db as never, {
      sessionId: "session_1", userId: "user_1",
      owner: { turnId: "turn_1", executionAttempt: { id: "execution_1", attemptCount: 3 } },
    }, write)).resolves.toEqual({ owned: false })

    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it("can require a still-running attempt for pipeline side effects", async () => {
    const { db, tx } = fakeDb()
    await withRunRecorderWriteOwnership(db as never, {
      sessionId: "session_1", userId: "user_1",
      owner: { turnId: "turn_1", executionAttempt: { id: "execution_1", attemptCount: 3 }, requireRunning: true },
    }, async () => undefined)

    expect(tx.agentExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["running"] } }),
    }))
  })

  it("skips the pipeline side effect when its running-attempt CAS loses", async () => {
    const { db } = fakeDb("in_progress", 0)
    const write = vi.fn()
    await expect(withRunRecorderWriteOwnership(db as never, {
      sessionId: "session_1", userId: "user_1",
      owner: { turnId: "turn_1", executionAttempt: { id: "execution_1", attemptCount: 3 }, requireRunning: true },
    }, write)).resolves.toEqual({ owned: false })
    expect(write).not.toHaveBeenCalled()
  })

  it("requires activation before recorder writes and keeps legacy writes inside an open-session lock", async () => {
    const { db, tx } = fakeDb()
    let activated = false
    const write = vi.fn(async () => "saved")
    const context = createRunRecorderWriteContext({
      db: db as never, sessionId: "session_1", userId: "user_1",
      isActivated: () => activated, getWriteOwner: () => null,
    })

    expect(() => context.assertActivated()).toThrow("must be activated after claiming")
    activated = true
    context.assertActivated()
    await expect(context.writeOwned(write)).resolves.toBe("saved")
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledOnce()
  })
})
