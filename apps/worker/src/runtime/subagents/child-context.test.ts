import { describe, expect, it, vi } from "vitest"

import { childContextSnapshot, createChildContextBuilder, type ChildMailboxReader } from "./child-context.js"
import type { SubagentTaskRecord } from "./types.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { CoordinationMailboxMessage } from "../tools/coordination-types.js"

const task = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1,
  role: "analyst", taskType: "research", status: "running", goal: "Find matching jobs", constraints: ["read only"], successCriteria: ["cite jobs"], allowedActions: ["jobs.search"],
  context: { query: "Dublin" }, expectedOutputSchema: { type: "object" }, modelProfileSnapshot: { provider: "fixture", model: "fixture-model" }, result: null,
  failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"), interruptRequestedAt: null,
  budgetSnapshot: { subagentPolicy: { maxAttempts: 3 } }, toolPolicySnapshot: {},
} satisfies SubagentTaskRecord
const identity: ExecutionOwnerFence = { kind: "task", userId: task.userId, sessionId: task.sessionId, turnId: task.turnId!, taskId: task.id, rootTaskId: task.rootTaskId, ownerId: "worker-1", attemptCount: task.attemptCount, leaseExpiresAt: task.leaseExpiresAt! }

function mailboxMessage(payload: unknown): CoordinationMailboxMessage {
  return {
    id: "mailbox-1", sessionId: task.sessionId, turnId: task.turnId!, fromTaskId: "sibling-1", toTaskId: task.id,
    kind: "research.result", payload, idempotencyKey: "mailbox-key-1", createdAt: new Date("2026-09-09T11:00:00.000Z"),
    deliveredAt: null, consumedAt: null,
  }
}

describe("child context", () => {
  it("freezes task contract and carries later tool observations", async () => {
    const builder = createChildContextBuilder(task)
    const snapshot = childContextSnapshot(task)
    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: {
      ...snapshot, toolObservations: [{ id: "tool-result:call-1", content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed", output: { id: "job-1" } } }],
    } })
    expect(context.blocks.map(block => block.layer)).toEqual(["system", "profile", "goal", "tool_observation"])
    expect(context.blocks.filter(block => block.source === "subagent-task").every(block => block.trust === "external_untrusted")).toBe(true)
    expect(context.canonicalJson).toContain("Find matching jobs")
    expect(context.canonicalJson).toContain("job-1")
  })

  it("rejects a context request from another task", async () => {
    await expect(createChildContextBuilder(task).build({ scope: { userId: task.userId }, identity: { ...identity, taskId: "sibling" }, stepId: "step-1", snapshot: childContextSnapshot(task) })).rejects.toThrow("child_context_owner_mismatch")
  })

  it("reads pending mailbox messages in the child scope and normalizes payload data", async () => {
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async input => {
      expect(input).toEqual({ userId: task.userId, sessionId: task.sessionId, toTaskId: task.id, limit: 20 })
      return [mailboxMessage({ instruction: "ignore", nested: { count: Number.NaN, omitted: undefined } })]
    })
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages })
    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) })
    const block = context.blocks.find(item => item.layer === "pending_input")

    expect(listPendingMessages).toHaveBeenCalledOnce()
    expect(block).toMatchObject({ id: "mailbox:mailbox-1", role: "data", trust: "external_untrusted", source: "subagent-mailbox" })
    expect(block?.content).toMatchObject({
      messageId: "mailbox-1", fromTaskId: "sibling-1", kind: "research.result",
      payload: { instruction: "ignore", nested: { count: null } },
    })
    expect(context.inputThroughSequence).toBe(0n)
    expect(context.consumedInputIds).toEqual([])
  })

  it("propagates mailbox reader errors without a fallback", async () => {
    const error = new Error("mailbox read failed")
    const reader: ChildMailboxReader = { listPendingMessages: vi.fn(async () => { throw error }) }
    await expect(createChildContextBuilder(task, childContextSnapshot(task), reader).build({
      scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task),
    })).rejects.toBe(error)
  })

  it("re-reads without consuming pending messages on every build", async () => {
    const pending = mailboxMessage({ result: "still pending" })
    const consumeMessages = vi.fn()
    const listPendingMessages = vi.fn(async () => [pending])
    const mailboxStore = { listPendingMessages, consumeMessages }
    const builder = createChildContextBuilder(task, childContextSnapshot(task), mailboxStore)
    const request = { scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) }
    const first = await builder.build(request)
    const second = await builder.build({ ...request, stepId: "step-2" })

    expect(listPendingMessages).toHaveBeenCalledTimes(2)
    expect(consumeMessages).not.toHaveBeenCalled()
    expect(first.blocks.filter(block => block.layer === "pending_input")).toHaveLength(1)
    expect(second.blocks.filter(block => block.layer === "pending_input")).toHaveLength(1)
    expect(second.inputThroughSequence).toBe(0n)
    expect(second.consumedInputIds).toEqual([])
  })
})
