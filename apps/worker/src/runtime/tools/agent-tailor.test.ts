import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "./registry.js"
import { createAgentTailorTool, registerAgentTailorTool } from "./agent-tailor.js"
import type { ToolExecutionContext } from "./types.js"

const receipt = { status: "accepted" as const, revision: 5,
  nodes: [{ key: "candidate-writer", taskId: "writer-task", status: "queued" as const },
    { key: "candidate-reviewer", taskId: "reviewer-task", status: "waiting" as const }], readyTaskIds: ["writer-task"] }
const options = { turnLeaseOwner: "worker-1", turnLeaseVersion: 3, parentLeaseOwner: "worker-1",
  parentAttemptCount: () => 2, rootInputId: "root-input" }
const candidateRef = `otc1_${"a".repeat(64)}`
const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
  taskId: "root-1", rootTaskId: "root-1", actorRole: "orchestrator", remainingTurnSteps: 3,
  signal: new AbortController().signal, capabilities: ["coordination", "canManageChildren"], reportProgress: vi.fn(), ...overrides,
})

describe("agent.tailor", () => {
  it("registers only when rollout, registry and both command seams are available", () => {
    const registry = new ToolRegistry([]), commandPort = {
      readObjectiveTailorCatalog: vi.fn(), appendObjectiveTailor: vi.fn(),
    }
    expect(registerAgentTailorTool(registry, commandPort as never, () => true, options)).toBe(true)
    expect(registry.list().map(tool => tool.name)).toContain("agent.tailor")

    const disabledRegistry = new ToolRegistry([])
    expect(registerAgentTailorTool(disabledRegistry, commandPort as never, () => false, options)).toBe(false)
    expect(disabledRegistry.list()).toHaveLength(0)
    expect(registerAgentTailorTool({} as never, commandPort as never, () => true, options)).toBe(false)
    expect(registerAgentTailorTool(new ToolRegistry([]), { appendObjectiveTailor: vi.fn() } as never, () => true, options)).toBe(false)
  })

  it("accepts only a current revision and opaque candidate ref, then delegates the exact Root scope", async () => {
    const appendObjectiveTailor = vi.fn(async () => receipt)
    const tool = createAgentTailorTool({ appendObjectiveTailor } as unknown as Parameters<typeof createAgentTailorTool>[0], options)
    const registry = new ToolRegistry([tool])
    const input = { expectedRevision: 4, candidateRef }

    expect(registry.validateArguments("agent.tailor", input, "1")).toBe(true)
    await expect(tool.execute(context(), input)).resolves.toEqual(receipt)
    expect(appendObjectiveTailor).toHaveBeenCalledWith({
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
        rootTaskId: "root-1", parentTaskId: "root-1", turnLeaseOwner: "worker-1", turnLeaseVersion: 3,
        parentLeaseOwner: "worker-1", parentAttemptCount: 2, rootInputId: "root-input" },
      expectedRevision: 4, candidateRef,
    })
  })

  it("rejects model-supplied evidence and identifiers through the closed input schema", () => {
    const tool = createAgentTailorTool({ appendObjectiveTailor: vi.fn() } as unknown as Parameters<typeof createAgentTailorTool>[0], options)
    const registry = new ToolRegistry([tool])
    expect(registry.validateArguments("agent.tailor", { expectedRevision: 4, candidateRef, jobId: "job-secret" }, "1"))
      .not.toBe(true)
    expect(registry.validateArguments("agent.tailor", { expectedRevision: 4, candidateRef, artifactRef: "artifact-secret" }, "1"))
      .not.toBe(true)
    expect(registry.validateArguments("agent.tailor", { expectedRevision: 4, candidateRef, sourceDigest: "sha256:secret" }, "1"))
      .not.toBe(true)
    expect(registry.validateArguments("agent.tailor", { expectedRevision: 0, candidateRef }, "1")).not.toBe(true)
    expect(registry.validateArguments("agent.tailor", { expectedRevision: 4, candidateRef: "arbitrary-ref" }, "1")).not.toBe(true)
  })

  const deniedContexts: Array<[string, Partial<ToolExecutionContext>]> = [
    ["child", { taskId: "child-1", actorRole: "subagent" }],
    ["non-root task", { taskId: "other-task" }],
    ["missing coordinator role", { actorRole: undefined }],
    ["missing capability", { capabilities: ["coordination"] }],
    ["insufficient continuation", { remainingTurnSteps: 1 }],
  ]
  it.each(deniedContexts)("fails closed for %s", async (_label, overrides) => {
    const appendObjectiveTailor = vi.fn(async () => receipt)
    const tool = createAgentTailorTool({ appendObjectiveTailor } as unknown as Parameters<typeof createAgentTailorTool>[0], options)
    await expect(tool.execute(context(overrides), { expectedRevision: 4, candidateRef })).rejects.toMatchObject({
      name: "ToolExecutionError",
    })
    expect(appendObjectiveTailor).not.toHaveBeenCalled()
  })

  it("fails closed when the runtime port has no tailoring implementation", async () => {
    const tool = createAgentTailorTool({} as unknown as Parameters<typeof createAgentTailorTool>[0], options)
    await expect(tool.execute(context(), { expectedRevision: 4, candidateRef })).rejects.toMatchObject({
      code: "objective_tailor_unavailable",
    })
  })

  it("does not expose command error text", async () => {
    const appendObjectiveTailor = vi.fn(async () => { throw Object.assign(new Error("PRIVATE_JOB_CONTENT"), { code: "objective_tailor_stale", currentRevision: 5 }) })
    const tool = createAgentTailorTool({ appendObjectiveTailor } as unknown as Parameters<typeof createAgentTailorTool>[0], options)
    await expect(tool.execute(context(), { expectedRevision: 4, candidateRef })).rejects.toMatchObject({
      code: "objective_tailor_stale", safeOutput: { code: "objective_tailor_stale", currentRevision: 5 },
    })
    await expect(tool.execute(context(), { expectedRevision: 4, candidateRef })).rejects.not.toThrow("PRIVATE_JOB_CONTENT")
  })
})
