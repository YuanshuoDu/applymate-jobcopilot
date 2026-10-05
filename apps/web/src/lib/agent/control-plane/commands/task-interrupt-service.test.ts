import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ append: vi.fn(), enqueue: vi.fn() }))

vi.mock("../../session/fact-store", () => ({ appendAgentEventWithOutboxInTransaction: mocks.append }))
vi.mock("./task-interrupt-intent", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-interrupt-intent")>()
  return { ...actual, enqueueTaskInterruptIntent: mocks.enqueue }
})

import { TaskInterruptError, TaskInterruptService } from "./task-interrupt-service"

const identity = {
  id: "task-child", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-root", parentTaskId: "task-root",
  path: "/task-root/task-child", depth: 1, status: "running", interruptRequestedAt: null,
  turnRootTaskId: "task-root", turnStatus: "in_progress", rootId: "task-root", rootParentTaskId: null,
  rootRootTaskId: "task-root", rootTurnId: "turn-1", rootPath: "/task-root", rootDepth: 0,
  rootRole: "orchestrator", rootTaskType: "root", rootStatus: "running",
}
const chain = [
  { id: "task-root", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-root", parentTaskId: null, path: "/task-root", depth: 0 },
  { id: "task-child", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-root", parentTaskId: "task-root", path: "/task-root/task-child", depth: 1 },
]

function harness(options: { sessionExists?: boolean; sessionStatus?: string; existing?: unknown; task?: typeof identity; lineage?: typeof chain } = {}) {
  const tx = {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce(options.sessionExists === false ? [] : [{ id: "session-1", status: options.sessionStatus ?? "active" }])
      .mockResolvedValueOnce([options.task ?? identity])
      .mockResolvedValueOnce(options.lineage ?? chain),
    agentOutbox: { findUnique: vi.fn().mockResolvedValue(options.existing ?? null) },
    agentEvent: { findFirst: vi.fn().mockResolvedValue({ sequence: BigInt(9) }) },
  }
  const db = { $transaction: vi.fn((work: (value: typeof tx) => unknown) => work(tx)) }
  mocks.append.mockResolvedValue({ event: { sequence: BigInt(10) }, duplicate: false })
  mocks.enqueue.mockResolvedValue(undefined)
  return { db, tx, service: new TaskInterruptService(db as never) }
}

const command = { sessionId: "session-1", taskId: "task-child", userId: "user-1", clientMessageId: "client-1" }

describe("TaskInterruptService", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("locks the owned session and atomically records accepted fact and intent", async () => {
    const { db, tx, service } = harness()
    await expect(service.interrupt(command)).resolves.toEqual({
      intentId: expect.any(String), taskId: "task-child", turnId: "turn-1", disposition: "accepted", sequence: "10",
    })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3)
    expect(mocks.append).toHaveBeenCalledWith(tx, expect.objectContaining({
      sessionId: "session-1", turnId: "turn-1", taskId: "task-child", type: "task.interrupt.accepted", outboxTopic: "agent.session.event",
    }))
    expect(mocks.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ sessionId: "session-1", turnId: "turn-1", taskId: "task-child" }))
  })

  it("rejects an unowned session before resolving a task", async () => {
    const { tx, service } = harness({ sessionExists: false })
    await expect(service.interrupt(command)).rejects.toMatchObject({ code: "task_interrupt_target_not_found", status: 404 })
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(mocks.append).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("rejects stale, terminal, and malformed ancestry", async () => {
    const stale = harness({ task: { ...identity, status: "completed" } })
    await expect(stale.service.interrupt(command)).rejects.toMatchObject({ code: "task_interrupt_target_unavailable", status: 409 })
    const malformed = harness({ lineage: [chain[0]!, { ...chain[1]!, path: "/another-root/task-child" }] })
    await expect(malformed.service.interrupt(command)).rejects.toBeInstanceOf(TaskInterruptError)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("replays the original target and conflicts when a key names another task", async () => {
    const existing = { aggregateId: "session-1", payload: { intentId: "intent-old", taskId: "task-child", turnId: "turn-1" } }
    const replay = harness({ existing })
    await expect(replay.service.interrupt(command)).resolves.toEqual({
      intentId: "intent-old", taskId: "task-child", turnId: "turn-1", disposition: "duplicate", sequence: "9",
    })
    expect(replay.tx.$queryRaw).toHaveBeenCalledOnce()
    const collision = harness({ existing })
    await expect(collision.service.interrupt({ ...command, taskId: "other-child" })).rejects.toMatchObject({ code: "task_interrupt_idempotency_conflict", status: 409 })
    expect(collision.tx.agentEvent.findFirst).not.toHaveBeenCalled()
  })

  it.each(["aborted", "archived"] as const)("replays an accepted command after the owned session is %s without resolving tasks", async sessionStatus => {
    const existing = { aggregateId: "session-1", payload: { intentId: "intent-old", taskId: "task-child", turnId: "turn-1" } }
    const replay = harness({ sessionStatus, existing })
    await expect(replay.service.interrupt(command)).resolves.toEqual({
      intentId: "intent-old", taskId: "task-child", turnId: "turn-1", disposition: "duplicate", sequence: "9",
    })
    expect(replay.tx.$queryRaw).toHaveBeenCalledOnce()
    expect(replay.tx.agentEvent.findFirst).toHaveBeenCalledOnce()
    expect(mocks.append).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it.each(["aborted", "archived"] as const)("keeps key collision and rejects new commands when the owned session is %s", async sessionStatus => {
    const existing = { aggregateId: "session-1", payload: { intentId: "intent-old", taskId: "task-child", turnId: "turn-1" } }
    const collision = harness({ sessionStatus, existing })
    await expect(collision.service.interrupt({ ...command, taskId: "other-child" })).rejects.toMatchObject({
      code: "task_interrupt_idempotency_conflict", status: 409,
    })
    expect(collision.tx.$queryRaw).toHaveBeenCalledOnce()
    expect(collision.tx.agentEvent.findFirst).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()

    const fresh = harness({ sessionStatus })
    await expect(fresh.service.interrupt({ ...command, clientMessageId: "client-new" })).rejects.toMatchObject({
      code: "task_interrupt_target_not_found", status: 404,
    })
    expect(fresh.tx.$queryRaw).toHaveBeenCalledOnce()
    expect(mocks.append).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
})
