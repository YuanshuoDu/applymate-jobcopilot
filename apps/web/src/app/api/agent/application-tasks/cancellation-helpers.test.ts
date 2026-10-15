import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  approvalUpdateMany: vi.fn(),
  fillerFindMany: vi.fn(),
  queryRaw: vi.fn(),
  taskInterrupt: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  err: (message: string, status: number) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentApproval: { updateMany: mocks.approvalUpdateMany },
    subAgentTask: { findMany: mocks.fillerFindMany },
  },
}))

vi.mock("@/lib/agent/control-plane/commands/task-interrupt-service", () => ({
  TaskInterruptError: class TaskInterruptError extends Error {
    constructor(_code: string, readonly status: number, message: string) { super(message) }
  },
  TaskInterruptService: class TaskInterruptService {
    interrupt = mocks.taskInterrupt
  },
}))

import {
  cancelPendingSubmitApprovals,
  hasBoundFillTurn,
  interruptBoundFiller,
  isStoppedFill,
  lockStoppedFillReplay,
} from "./cancellation-helpers"

const binding = {
  sessionId: "session_1",
  fillTurnId: "turn_1",
  fillTurnSessionId: "session_1",
  fillTurnUserId: "user_1",
}

describe("application-task cancellation helpers", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.approvalUpdateMany.mockResolvedValue({ count: 1 })
    mocks.fillerFindMany.mockResolvedValue([])
    mocks.queryRaw.mockResolvedValue([{ id: "task_1" }])
    mocks.taskInterrupt.mockResolvedValue(undefined)
  })

  it("accepts only the exact bound user, session, and fill Turn", () => {
    expect(hasBoundFillTurn(binding, "user_1")).toBe(true)
    expect(hasBoundFillTurn({ ...binding, fillTurnSessionId: "session_2" }, "user_1")).toBe(false)
    expect(hasBoundFillTurn({ ...binding, fillTurnUserId: "user_2" }, "user_1")).toBe(false)
    expect(hasBoundFillTurn({ ...binding, fillTurnId: null }, "user_1")).toBe(false)
  })

  it("recognizes only a cancelled fill stopped before submission", () => {
    const stopped = { ...binding, status: "cancelled", checkpoint: "turn_stopped_before_submit" }
    expect(isStoppedFill(stopped, "user_1")).toBe(true)
    expect(isStoppedFill({ ...stopped, checkpoint: "cancelled_by_user" }, "user_1")).toBe(false)
    expect(isStoppedFill({ ...stopped, status: "filling" }, "user_1")).toBe(false)
    expect(isStoppedFill({ ...stopped, fillTurnUserId: "user_2" }, "user_1")).toBe(false)
  })

  it("cancels only pending submit approvals owned by the exact task, user, and session", async () => {
    await cancelPendingSubmitApprovals({ agentApproval: { updateMany: mocks.approvalUpdateMany } } as never, "task_1", "session_1", "user_1")

    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: {
        sessionId: "session_1", userId: "user_1", type: "submit_application", status: "pending",
        payload: { path: ["applicationTaskId"], equals: "task_1" },
      },
      data: { status: "cancelled", decidedAt: expect.any(Date) },
    })
  })

  it("locks replay only for the complete original binding and stopped-before-submit state", async () => {
    const task = { id: "task_1", ...binding }
    const locked = await lockStoppedFillReplay({ $queryRaw: mocks.queryRaw } as never, task, "user_1")

    expect(locked).toBe(true)
    const query = mocks.queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] }
    expect(query.sql).toContain('FROM "application_tasks"')
    expect(query.sql).toContain('"fillTurnId" = ?')
    expect(query.sql).toContain('"status" = ?')
    expect(query.sql).toContain('"checkpoint" = ?')
    expect(query.sql).toContain("FOR UPDATE")
    expect(query.values).toEqual([
      "task_1", "user_1", "session_1", "turn_1", "session_1", "user_1", "cancelled", "turn_stopped_before_submit",
    ])
  })

  it("rejects an empty replay lock result", async () => {
    mocks.queryRaw.mockResolvedValueOnce([])
    await expect(lockStoppedFillReplay({ $queryRaw: mocks.queryRaw } as never, { id: "task_1", ...binding }, "user_1"))
      .resolves.toBe(false)
  })

  it("interrupts exactly one active filler with a stable request identity", async () => {
    mocks.fillerFindMany.mockResolvedValueOnce([{ id: "filler_1", status: "running" }])
    await expect(interruptBoundFiller({ id: "task_1", sessionId: "session_1", fillTurnId: "turn_1" }, "user_1"))
      .resolves.toBeNull()

    expect(mocks.fillerFindMany).toHaveBeenCalledWith({
      where: { sessionId: "session_1", turnId: "turn_1", role: "application_filler", taskType: "application_fill_for_review" },
      select: { id: true, status: true },
    })
    expect(mocks.taskInterrupt).toHaveBeenCalledWith({
      sessionId: "session_1", taskId: "filler_1", userId: "user_1",
      clientMessageId: "application-task-cancel:task_1:turn_1",
    })
  })

  it("treats a missing filler as already stopped", async () => {
    await expect(interruptBoundFiller({ id: "task_1", sessionId: "session_1", fillTurnId: "turn_1" }, "user_1"))
      .resolves.toBeNull()
    expect(mocks.taskInterrupt).not.toHaveBeenCalled()
  })

  it("returns conflicts for ambiguous or unrecognized fillers and skips terminal fillers", async () => {
    mocks.fillerFindMany.mockResolvedValueOnce([{ id: "a", status: "running" }, { id: "b", status: "queued" }])
    const ambiguous = await interruptBoundFiller({ id: "task_1", sessionId: "session_1", fillTurnId: "turn_1" }, "user_1")
    expect(ambiguous?.status).toBe(409)

    mocks.fillerFindMany.mockResolvedValueOnce([{ id: "a", status: "mysterious" }])
    const unknown = await interruptBoundFiller({ id: "task_1", sessionId: "session_1", fillTurnId: "turn_1" }, "user_1")
    expect(unknown?.status).toBe(409)

    mocks.fillerFindMany.mockResolvedValueOnce([{ id: "a", status: "completed" }])
    await expect(interruptBoundFiller({ id: "task_1", sessionId: "session_1", fillTurnId: "turn_1" }, "user_1"))
      .resolves.toBeNull()
    expect(mocks.taskInterrupt).not.toHaveBeenCalled()
  })

  it("preserves interrupt-service conflicts and maps unexpected failures to 500", async () => {
    const { TaskInterruptError } = await import("@/lib/agent/control-plane/commands/task-interrupt-service")
    mocks.fillerFindMany.mockResolvedValue([{ id: "filler_1", status: "running" }])
    mocks.taskInterrupt.mockRejectedValueOnce(new TaskInterruptError("interrupt_conflict", 409, "already stopped"))
    const conflict = await interruptBoundFiller({ id: "task_1", sessionId: "session_1", fillTurnId: "turn_1" }, "user_1")
    expect(conflict?.status).toBe(409)

    mocks.taskInterrupt.mockRejectedValueOnce(new Error("database unavailable"))
    const failure = await interruptBoundFiller({ id: "task_1", sessionId: "session_1", fillTurnId: "turn_1" }, "user_1")
    expect(failure?.status).toBe(500)
  })
})
