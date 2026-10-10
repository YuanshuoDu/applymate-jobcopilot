import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "./registry.js"
import type { ToolExecutionContext } from "./types.js"
import { createSteeringReconciliationTool } from "./steering-reconciliation.js"
import type { TaskGraphCommandPort } from "../subagents/task-graph-command-port.js"

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-2", toolCallId: "persisted-call",
    taskId: "root-1", rootTaskId: "root-1", signal: new AbortController().signal, capabilities: ["coordination", "canManageChildren"],
    reportProgress: async () => undefined, ...overrides }
}
const options = { turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "root-owner", parentAttemptCount: () => 2, rootInputId: "original-input" }

describe("agent.reconcile tool", () => {
  it("accepts only keep and an agenda revision; model input cannot choose scope, evidence, or permissions", () => {
    const reconcileSteering = vi.fn(async () => ({ decision: "keep" as const, revision: 4, reconciledInputCount: 2 }))
    const tool = createSteeringReconciliationTool({ reconcileSteering } as unknown as TaskGraphCommandPort, options)
    const registry = new ToolRegistry([tool])

    expect(registry.validateArguments("agent.reconcile", { decision: "keep", expectedRevision: 4 })).toBe(true)
    for (const extra of [
      { steerInputIds: ["private" ] }, { rationale: "private" }, { taskId: "forged" }, { decision: "revise" },
    ]) expect(registry.validateArguments("agent.reconcile", { decision: "keep", expectedRevision: 4, ...extra })).not.toBe(true)
    expect(tool).toMatchObject({ risk: "internal_write", domain: "coordination", requiredCapabilities: ["coordination", "canManageChildren"] })
  })

  it("uses the persisted call and runtime root fence, and returns no private input identifiers", async () => {
    const reconcileSteering = vi.fn(async () => ({ decision: "keep" as const, revision: 4, reconciledInputCount: 2 }))
    const tool = createSteeringReconciliationTool({ reconcileSteering } as unknown as TaskGraphCommandPort, options)

    await expect(tool.execute(context(), { decision: "keep", expectedRevision: 4 })).resolves.toEqual({
      decision: "keep", revision: 4, reconciledInputCount: 2,
    })
    expect(reconcileSteering).toHaveBeenCalledWith({
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-2", rootTaskId: "root-1", parentTaskId: "root-1",
        turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "root-owner", parentAttemptCount: 2 },
      decision: "keep", expectedRevision: 4, callId: "persisted-call", rootInputId: "original-input",
    })
    expect(JSON.stringify(tool.outputSchema)).not.toContain("steerInputIds")
  })

  it("fails closed if the persisted tool-call identity or atomic port is unavailable", async () => {
    const reconcileSteering = vi.fn()
    const tool = createSteeringReconciliationTool({ reconcileSteering } as unknown as TaskGraphCommandPort, options)
    await expect(tool.execute(context({ toolCallId: undefined }), { decision: "keep", expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "steering_reconciliation_call_unavailable" })
    await expect(createSteeringReconciliationTool({} as TaskGraphCommandPort, options)
      .execute(context(), { decision: "keep", expectedRevision: 0 }))
      .rejects.toMatchObject({ code: "steering_reconciliation_unavailable" })
    expect(reconcileSteering).not.toHaveBeenCalled()
  })
})
