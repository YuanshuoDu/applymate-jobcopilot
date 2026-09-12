import { describe, expect, it } from "vitest"

import { childContextSnapshot, createChildContextBuilder } from "./child-context.js"
import type { SubagentTaskRecord } from "./types.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"

const task = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1,
  role: "analyst", taskType: "research", status: "running", goal: "Find matching jobs", constraints: ["read only"], successCriteria: ["cite jobs"], allowedActions: ["jobs.search"],
  context: { query: "Dublin" }, expectedOutputSchema: { type: "object" }, modelProfileSnapshot: { provider: "fixture", model: "fixture-model" }, result: null,
  failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"), interruptRequestedAt: null,
  budgetSnapshot: { subagentPolicy: { maxAttempts: 3 } }, toolPolicySnapshot: {},
} satisfies SubagentTaskRecord
const identity: ExecutionOwnerFence = { kind: "task", userId: task.userId, sessionId: task.sessionId, turnId: task.turnId!, taskId: task.id, rootTaskId: task.rootTaskId, ownerId: "worker-1", attemptCount: task.attemptCount, leaseExpiresAt: task.leaseExpiresAt! }

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
})
