import { describe, expect, it } from "vitest"
import { captureSubagentParentExecutionFence, clampNestedSubagentPolicy } from "./parent-execution-fence.js"
import { normalizeSubagentPolicy, SubagentLeaseError, type SubagentLease } from "./types.js"

function lease(overrides: Partial<SubagentLease> = {}): SubagentLease {
  return {
    id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
    parentTaskId: "root-1", path: "/root-1/parent-1", depth: 1, role: "scout", taskType: "research",
    status: "running", goal: "inspect", constraints: [], successCriteria: [], allowedActions: [], context: {},
    expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3,
    leaseOwner: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00Z"), interruptRequestedAt: null,
    budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
    ...overrides,
  }
}

const spec = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1" }

describe("subagent parent execution fence", () => {
  it("captures only the minimal readonly lease tuple after exact spec binding", () => {
    const fence = captureSubagentParentExecutionFence(spec, lease())
    expect(fence).toEqual({
      id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
      rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 2,
    })
    expect(Object.keys(fence).sort()).toEqual(["attemptCount", "id", "ownerId", "rootTaskId", "sessionId", "turnId", "userId"])
    expect(Object.isFrozen(fence)).toBe(true)
  })

  it.each([
    ["userId", "user-2"], ["sessionId", "session-2"], ["turnId", "turn-2"], ["parentTaskId", "other-parent"],
  ] as const)("rejects a mismatched %s", (field, value) => {
    expect(() => captureSubagentParentExecutionFence({ ...spec, [field]: value }, lease()))
      .toThrowError(SubagentLeaseError)
    expect(() => captureSubagentParentExecutionFence({ ...spec, [field]: value }, lease()))
      .toThrowError(expect.objectContaining({ code: "lost" }))
  })

  it.each([
    ["aborted", { signal: AbortSignal.abort() }],
    ["terminal", { status: "completed" as const }],
    ["reclaimed", { ownerId: "new-owner" }],
    ["invalid attempt", { attemptCount: 0 }],
  ])("rejects an %s execution", (_case, override) => {
    expect(() => captureSubagentParentExecutionFence(spec, lease(override))).toThrowError(
      expect.objectContaining({ code: "lost" }),
    )
  })

  it("clamps nested depth and fan-out while preserving other inherited limits", () => {
    expect(clampNestedSubagentPolicy(normalizeSubagentPolicy({
      maxConcurrency: 3, maxDepth: 8, maxFanOut: 5, maxAttempts: 4,
    }))).toEqual({ maxConcurrency: 3, maxDepth: 2, maxFanOut: 2, maxAttempts: 4 })
    expect(clampNestedSubagentPolicy(normalizeSubagentPolicy({ maxDepth: 1, maxFanOut: 1 })))
      .toMatchObject({ maxDepth: 1, maxFanOut: 1 })
  })
})
