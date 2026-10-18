import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ append: vi.fn() }))
vi.mock("../../session/fact-store", () => ({ appendAgentEventWithOutboxInTransaction: mocks.append }))

import { TaskMessageError, TaskMessageService } from "./task-message-service"

const now = new Date("2026-10-18T09:00:00.000Z")
const identity = {
  id: "task-child", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-root", parentTaskId: "task-root",
  path: "/task-root/task-child", depth: 1, status: "running", attemptCount: 3, leaseOwner: "worker-1",
  leaseExpiresAt: new Date(now.getTime() + 60_000), interruptRequestedAt: null,
  turnRootTaskId: "task-root", turnStatus: "in_progress", rootId: "task-root", rootParentTaskId: null,
  rootRootTaskId: "task-root", rootTurnId: "turn-1", rootPath: "/task-root", rootDepth: 0,
  rootRole: "orchestrator", rootTaskType: "root", rootStatus: "running", rootInterruptRequestedAt: null,
}
const chain = [
  { id: "task-root", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-root", parentTaskId: null,
    path: "/task-root", depth: 0, status: "running", interruptRequestedAt: null },
  { id: "task-child", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-root", parentTaskId: "task-root",
    path: "/task-root/task-child", depth: 1, status: "running", interruptRequestedAt: null },
]
const command = { sessionId: "session-1", taskId: "task-child", userId: "user-1", clientMessageId: "client-1",
  text: "Please check the result", expectedAttemptCount: 3, now }

function harness(options: { session?: Array<{ id: string; status: string }>; identity?: Record<string, unknown>; chain?: Array<Record<string, unknown>>; existing?: unknown; pendingInterrupt?: boolean } = {}) {
  const tx = {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce(options.session ?? [{ id: "session-1", status: "running" }])
      .mockResolvedValueOnce([options.identity ?? identity])
      .mockResolvedValueOnce(options.chain ?? chain)
      .mockResolvedValueOnce(options.pendingInterrupt ? [{ id: "interrupt-intent" }] : []),
    agentMailboxMessage: { findFirst: vi.fn().mockResolvedValue(options.existing ?? null), create: vi.fn().mockResolvedValue({}) },
    agentOutbox: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ aggregateId: "session-1", topic: "agent.subagent.mailbox", payload: {
        messageId: "message-1", sessionId: "session-1", turnId: "turn-1", toTaskId: "task-child", targetAttemptCount: 3,
      } }),
    },
    agentItem: { create: vi.fn().mockResolvedValue({}) },
    agentEvent: { findFirst: vi.fn().mockResolvedValue({ sequence: BigInt(9), itemId: "item-1", taskId: "task-child", turnId: "turn-1",
      payload: { messageId: "message-1", clientMessageId: "client-1", targetAttemptCount: 3 } }) },
  }
  const db = { $transaction: vi.fn((work: (value: typeof tx) => unknown) => work(tx)) }
  mocks.append.mockResolvedValue({ event: { sequence: BigInt(10) }, duplicate: false })
  return { db, tx, service: new TaskMessageService(db as never) }
}

function stored(overrides: Record<string, unknown> = {}) {
  return { id: "message-1", sessionId: "session-1", turnId: "turn-1", toTaskId: "task-child",
    kind: "human_follow_up", targetAttemptCount: 3, payload: { text: command.text }, ...overrides }
}

describe("TaskMessageService", () => {
  beforeEach(() => vi.clearAllMocks())

  it("locks owner, validates the live lineage, and atomically writes mailbox, item, and accepted event", async () => {
    const { db, tx, service } = harness()
    await expect(service.send(command)).resolves.toEqual({
      messageId: expect.any(String), itemId: expect.any(String), taskId: "task-child", turnId: "turn-1",
      targetAttemptCount: 3, disposition: "accepted", sequence: "10",
    })
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4)
    expect(tx.agentMailboxMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sessionId: "session-1", turnId: "turn-1", toTaskId: "task-child", kind: "human_follow_up",
      targetAttemptCount: 3, payload: { text: command.text }, idempotencyKey: "human-follow-up:client-1",
    }) })
    expect(tx.agentOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      topic: "agent.subagent.mailbox", aggregateId: "session-1",
      idempotencyKey: "agent-subagent-mailbox:session-1:client-1",
      payload: { messageId: expect.any(String), sessionId: "session-1", turnId: "turn-1", toTaskId: "task-child", targetAttemptCount: 3 },
    }) })
    expect(tx.agentItem.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sessionId: "session-1", turnId: "turn-1", taskId: "task-child", type: "user_message", status: "completed",
    }) })
    expect(mocks.append).toHaveBeenCalledWith(tx, expect.objectContaining({
      sessionId: "session-1", turnId: "turn-1", taskId: "task-child", itemId: expect.any(String),
      type: "input.accepted", actor: "user", outboxTopic: "agent.session.event",
      payload: expect.objectContaining({ delivery: "follow_up", targetAttemptCount: 3, item: expect.objectContaining({ taskId: "task-child" }) }),
    }))
  })

  it("fails closed for unowned sessions without issuing writes", async () => {
    const { tx, service } = harness({ session: [] })
    await expect(service.send(command)).rejects.toMatchObject({ code: "task_follow_up_target_not_found", status: 404 })
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.agentMailboxMessage.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(tx.agentItem.create).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
  })

  it.each([
    ["terminal task", { status: "completed" }],
    ["expired lease", { leaseExpiresAt: new Date(now.getTime() - 1) }],
    ["missing lease owner", { leaseOwner: null }],
    ["interrupt request", { interruptRequestedAt: now }],
    ["terminal Turn", { turnStatus: "completed" }],
    ["terminal root", { rootStatus: "completed" }],
    ["root interrupt request", { rootInterruptRequestedAt: now }],
  ] as const)("rejects %s before any write", async (_label, changes) => {
    const { tx, service } = harness({ identity: { ...identity, ...changes } })
    await expect(service.send(command)).rejects.toBeInstanceOf(TaskMessageError)
    expect(tx.agentMailboxMessage.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(tx.agentItem.create).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
  })

  it("rejects stale expected attempts and malformed ancestry without writes", async () => {
    const stale = harness()
    await expect(stale.service.send({ ...command, expectedAttemptCount: 2 })).rejects.toMatchObject({
      code: "task_follow_up_attempt_changed", status: 409,
    })
    const malformed = harness({ chain: [chain[0]!, { ...chain[1]!, path: "/wrong/task-child" }] })
    await expect(malformed.service.send(command)).rejects.toMatchObject({ code: "task_follow_up_target_unavailable", status: 409 })
    expect(stale.tx.agentMailboxMessage.create).not.toHaveBeenCalled()
    expect(malformed.tx.agentMailboxMessage.create).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
  })

  it("rejects a new follow-up while an accepted ancestor interrupt intent is pending", async () => {
    const ancestor = { id: "task-parent", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-root", parentTaskId: "task-root",
      path: "/task-root/task-parent", depth: 1, status: "running", interruptRequestedAt: null }
    const descendant = { ...chain[1]!, parentTaskId: "task-parent", path: "/task-root/task-parent/task-child", depth: 2 }
    const { tx, service } = harness({
      identity: { ...identity, parentTaskId: "task-parent", path: descendant.path, depth: 2 },
      chain: [chain[0]!, ancestor, descendant], pendingInterrupt: true,
    })
    await expect(service.send(command)).rejects.toMatchObject({ code: "task_follow_up_target_unavailable", status: 409 })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4)
    expect((tx.$queryRaw.mock.calls[3]?.[0] as { values: unknown[] }).values)
      .toEqual(expect.arrayContaining(["task-root", "task-parent", "task-child"]))
    expect(tx.agentMailboxMessage.create).not.toHaveBeenCalled()
    expect(tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(tx.agentItem.create).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
  })

  it("returns an exact retry and conflicts when the same key changes any binding", async () => {
    const existing = harness({ existing: stored() })
    await expect(existing.service.send(command)).resolves.toEqual({
      messageId: "message-1", itemId: "item-1", taskId: "task-child", turnId: "turn-1",
      targetAttemptCount: 3, disposition: "duplicate", sequence: "9",
    })
    expect(existing.tx.agentMailboxMessage.create).not.toHaveBeenCalled()
    expect(existing.tx.agentItem.create).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()

    for (const saved of [stored({ toTaskId: "another-task" }), stored({ turnId: "another-turn" }),
      stored({ payload: { text: "different text" } })]) {
      const collision = harness({ existing: saved })
      await expect(collision.service.send(command)).rejects.toMatchObject({ code: "task_follow_up_idempotency_conflict", status: 409 })
      expect(collision.tx.agentMailboxMessage.create).not.toHaveBeenCalled()
      expect(collision.tx.agentOutbox.create).not.toHaveBeenCalled()
      expect(collision.tx.agentItem.create).not.toHaveBeenCalled()
    }
    const staleAttempt = harness({ existing: stored({ targetAttemptCount: 2 }) })
    await expect(staleAttempt.service.send(command)).rejects.toMatchObject({ code: "task_follow_up_attempt_changed", status: 409 })
    expect(staleAttempt.tx.agentMailboxMessage.create).not.toHaveBeenCalled()
  })

  it("returns the original receipt for an exact retry after the task becomes terminal and advances", async () => {
    const terminal = harness({
      identity: { ...identity, attemptCount: 4, status: "completed", turnStatus: "completed", rootStatus: "completed",
        leaseOwner: null, leaseExpiresAt: new Date(now.getTime() - 1), interruptRequestedAt: now, rootInterruptRequestedAt: now },
      chain: chain.map(row => ({ ...row, status: "completed", interruptRequestedAt: now })),
      existing: stored(),
    })
    await expect(terminal.service.send(command)).resolves.toMatchObject({ disposition: "duplicate", messageId: "message-1", sequence: "9" })
    expect(terminal.tx.agentMailboxMessage.create).not.toHaveBeenCalled()
    expect(terminal.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(terminal.tx.agentItem.create).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
  })

  it("fails closed when the saved fact or mailbox dispatch is missing on replay", async () => {
    const { tx, service } = harness({ existing: stored() })
    tx.agentOutbox.findUnique.mockResolvedValue(null)
    await expect(service.send(command)).rejects.toMatchObject({ code: "task_follow_up_replay_unavailable", status: 409 })
    expect(tx.agentMailboxMessage.create).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
  })
})
