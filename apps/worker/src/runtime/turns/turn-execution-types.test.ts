import { describe, expect, it } from "vitest"

import { executionId, executionKey, type TurnExecutionIdentity } from "./turn-execution-types.js"

const root: TurnExecutionIdentity = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-09-08T03:00:00.000Z"),
}

const child: TurnExecutionIdentity = {
  kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1", rootTaskId: "root-1",
  ownerId: "worker-2", attemptCount: 2, leaseExpiresAt: new Date("2026-09-08T03:00:00.000Z"),
}

describe("turn execution identity helpers", () => {
  it("uses the owner kind and actual task identity for durable keys", () => {
    expect(executionKey(root)).toBe("turn:turn-1")
    expect(executionKey(child)).toBe("task:child-1")
    expect(executionId(child, "item:final")).toBe("task:child-1:item:final")
  })

  it("keeps root and child generated identities disjoint in one turn", () => {
    expect(executionId(root, "step:0")).not.toBe(executionId(child, "step:0"))
    expect(executionId(root, "event:turn-started")).toBe("turn:turn-1:event:turn-started")
  })
})
