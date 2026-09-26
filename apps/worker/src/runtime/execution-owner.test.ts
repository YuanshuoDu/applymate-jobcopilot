import { describe, expect, it } from "vitest"

import { ExecutionOwnerError, executionOwnerFence, type TaskExecutionOwner } from "./execution-owner.js"
import type { SubagentLease } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"

const expiry = new Date("2026-09-08T03:00:00.000Z")

const turn: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 4,
  leaseStartedAt: new Date("2026-09-08T02:59:00.000Z"), leaseExpiresAt: expiry,
}

const task: SubagentLease = {
  id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/task-1", depth: 1, role: "reader", taskType: "read", status: "running", goal: "read",
  constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null,
  failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: expiry,
  interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
}

describe("executionOwnerFence", () => {
  it("normalizes a root turn lease with its explicit root task identity", () => {
    expect(executionOwnerFence({ kind: "turn", taskId: "root-1", lease: turn })).toEqual({
      kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
      ownerId: "worker-1", leaseVersion: 4, leaseExpiresAt: expiry,
    })
  })

  it("normalizes a child task lease without coercing it to a turn lease", () => {
    const owner: TaskExecutionOwner = { kind: "task", lease: task }
    expect(executionOwnerFence(owner)).toMatchObject({
      kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
      ownerId: "worker-1", attemptCount: 2,
    })
  })

  it("rejects a child lease without a turn or an interrupted task", () => {
    expect(() => executionOwnerFence({ kind: "task", lease: { ...task, turnId: null } })).toThrow(ExecutionOwnerError)
    expect(() => executionOwnerFence({ kind: "task", lease: { ...task, interruptRequestedAt: new Date() } })).toThrow(ExecutionOwnerError)
  })

  it("rejects invalid turn fencing fields", () => {
    expect(() => executionOwnerFence({ kind: "turn", taskId: "root-1", lease: { ...turn, leaseVersion: -1 } })).toThrow(ExecutionOwnerError)
    expect(() => executionOwnerFence({ kind: "turn", taskId: "root-1", lease: { ...turn, leaseVersion: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(ExecutionOwnerError)
    expect(() => executionOwnerFence({ kind: "turn", taskId: "", lease: turn })).toThrow(ExecutionOwnerError)
  })

  it("rejects an unclaimed subagent attempt", () => {
    expect(() => executionOwnerFence({ kind: "task", lease: { ...task, attemptCount: 0 } })).toThrow(ExecutionOwnerError)
    expect(() => executionOwnerFence({ kind: "task", lease: { ...task, attemptCount: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(ExecutionOwnerError)
  })
})
