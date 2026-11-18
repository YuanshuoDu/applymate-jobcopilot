import { describe, expect, it, vi } from "vitest"
import { buildAgentSourceMaterialFenceKey } from "@jobcopilot/shared"
import { createRunRecorderWriteContext, withRunRecorderTerminalOwnership, withRunRecorderWriteOwnership } from "./run-recorder-ownership"

function fakeDb(turnStatus = "in_progress", executionCount = 1, fenceTransactionIds: readonly [string, string] = ["17", "17"]) {
  const order: string[] = []
  const sourceFenceKeys: unknown[] = []
  let sourceFenceQueryCount = 0
  const tx = {
    $queryRaw: vi.fn(async (query: unknown, ...templateValues: unknown[]) => {
      const strings = Array.isArray(query)
        ? query as unknown as readonly string[]
        : (query as { strings?: readonly string[] }).strings ?? []
      const sql = strings.join(" ")
      if (sql.includes("pg_advisory_xact_lock")) {
        order.push("source-fence")
        sourceFenceKeys.push(templateValues[0])
        const transactionId = fenceTransactionIds[sourceFenceQueryCount++]
        return [{ transaction_id: transactionId, lock_acquired: "" }]
      }
      if (sql.includes("pg_current_xact_id()::text AS transaction_id")) {
        order.push("source-fence-verification")
        const transactionId = fenceTransactionIds[sourceFenceQueryCount++]
        return [{ transaction_id: transactionId }]
      }
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
  return { db, tx, order, sourceFenceKeys }
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

  it("takes the exact user's source fence before any owner lock when explicitly opted in", async () => {
    const { db, tx, order, sourceFenceKeys } = fakeDb()
    const authenticatedUserId = "authenticated-user"
    const write = vi.fn(async () => { order.push("protected-write") })

    await expect(withRunRecorderWriteOwnership(db as never, {
      sessionId: "session_1", userId: authenticatedUserId,
      owner: { turnId: "turn_1", executionAttempt: { id: "execution_1", attemptCount: 3 } },
      requireSourceMaterialFence: true,
    }, write)).resolves.toEqual({ owned: true, value: undefined })

    expect(sourceFenceKeys).toEqual([buildAgentSourceMaterialFenceKey(authenticatedUserId)])
    expect(order).toEqual(["source-fence", "source-fence-verification", "session-lock", "turn-lock", "execution-lock", "protected-write"])
  })

  it("fails closed before owner locks or writes when the opted-in source fence fails", async () => {
    const { db, tx, order } = fakeDb("in_progress", 1, ["17", "18"])
    const write = vi.fn()

    let caught: unknown
    try {
      await withRunRecorderWriteOwnership(db as never, {
        sessionId: "session_1", userId: "user_1",
        owner: { turnId: "turn_1", executionAttempt: { id: "execution_1", attemptCount: 3 } },
        requireSourceMaterialFence: true,
      }, write)
    } catch (error) {
      caught = error
    }
    if (!(caught instanceof Error)) throw new Error("Expected source fence verification to fail")
    expect(caught.message).toBe("source material fence transaction verification failed")

    expect(order).toEqual(["source-fence", "source-fence-verification"])
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it("does not acquire the source fence for existing non-opted-in writes", async () => {
    const { db, order } = fakeDb()
    await withRunRecorderWriteOwnership(db as never, {
      sessionId: "session_1", userId: "user_1",
      owner: { turnId: "turn_1", executionAttempt: { id: "execution_1", attemptCount: 3 } },
    }, async () => undefined)
    expect(order).toEqual(["session-lock", "turn-lock", "execution-lock"])
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
