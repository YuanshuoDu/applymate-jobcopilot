import { Type } from "@sinclair/typebox"
import { describe, expect, it, vi } from "vitest"
import { PolicyEngine, type RuntimePolicyDecision } from "@jobcopilot/agent-policy"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"
import { ToolRegistry } from "../tools/registry.js"

const control = vi.hoisted(() => ({ canManageChildren: false }))

vi.mock("./role-policy.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./role-policy.js")>()
  return {
    ...actual,
    getSubagentRolePolicy: (role: string) => {
      const policy = actual.getSubagentRolePolicy(role)
      return policy ? { ...policy, canManageChildren: control.canManageChildren } : null
    },
  }
})

import { createPrivateSelectedJobToolExecutor, registerProductionChildWaitTool } from "./production-child-tools.js"

const sourceDigest = `sha256:${"a".repeat(64)}`
const artifactRef = { artifactId: "artifact-1", version: 1, contentHash: sourceDigest, sourceDigest }
const request = { id: "read-call", toolName: "artifact.version.read", toolVersion: "1", input: { artifactRef } }

function privateContext() {
  const taskFence: AgentArtifactTaskFence = {
    taskId: "reviewer-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
    parentTaskId: null, leaseOwner: "worker-1", attemptCount: 1,
  }
  return {
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    taskId: "reviewer-1", rootTaskId: "root-1", actorRole: "subagent" as const,
    selectedJobPreparation: { jobId: "job-1", sourceDigest, evidenceRefs: [] }, taskFence,
    signal: new AbortController().signal, capabilities: ["read"],
  }
}

function executorFixture() {
  const executeTool = vi.fn(async () => ({ artifactRef, content: "private artifact" }))
  const registry = new ToolRegistry([{
    schemaVersion, name: "artifact.version.read", version: "1", description: "Read selected-job artifact version",
    capabilities: ["read"], domain: "resume", inputSchema: Type.Object({ artifactRef: Type.Object({
      artifactId: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }),
      contentHash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), sourceDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    }, { additionalProperties: false }) }, { additionalProperties: false }),
    outputSchema: Type.Object({ artifactRef: Type.Unknown(), content: Type.Unknown() }, { additionalProperties: false }),
    risk: "read", idempotency: "read_only", timeoutMs: 1000, requiredCapabilities: [],
    execute: async () => executeTool(),
  }])
  const policy = new PolicyEngine({ snapshot: { version: "policy.v1", rules: [{
    id: "private-artifact-read", roles: ["subagent"], tools: ["artifact.version.read"], outcome: "allow",
    reasonCode: "test_allowed", reason: "Allowed for test",
  }] } })
  return { executeTool, createExecutor: (recordPolicyDecision: (decision: RuntimePolicyDecision) => Promise<void>) => createPrivateSelectedJobToolExecutor({
    task: { role: "reviewer" }, registry, policy, recordPolicyDecision,
  }) }
}

const lease = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "running", goal: "", constraints: [],
  successCriteria: [], allowedActions: ["wait_subagents"], context: {}, expectedOutputSchema: {}, result: null, failureReason: null,
  attemptCount: 1, maxAttempts: 1, leaseOwner: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null,
  budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
} as SubagentLease

function task(allowedActions: unknown): Pick<SubagentTaskRecord, "role" | "allowedActions"> {
  return { role: "scout", allowedActions }
}

describe("registerProductionChildWaitTool", () => {
  it("registers only wait_subagents after both server policy and persisted action allow it", () => {
    control.canManageChildren = false
    const disabled = new ToolRegistry([])
    expect(registerProductionChildWaitTool({ pool: {} as never, task: task(["wait_subagents"]), lease, registry: disabled })).toBe(false)
    expect(disabled.list()).toEqual([])

    control.canManageChildren = true
    const enabled = new ToolRegistry([])
    expect(registerProductionChildWaitTool({
      pool: {} as never, task: task(["wait_subagents", "spawn_subagent"]), lease, registry: enabled,
    })).toBe(true)
    expect(enabled.list().map(definition => definition.name)).toEqual(["wait_subagents"])
    expect(enabled.resolve("wait_subagents", "1")).toMatchObject({ risk: "internal_write", domain: "coordination", idempotency: "requires_key" })
  })

  it("rejects aliases, malformed action values, and unknown roles", () => {
    control.canManageChildren = true
    for (const allowedActions of [["agent.wait"], "wait_subagents", null, [1]]) {
      const registry = new ToolRegistry([])
      expect(registerProductionChildWaitTool({ pool: {} as never, task: task(allowedActions), lease, registry })).toBe(false)
      expect(registry.list()).toEqual([])
    }
    const unknown = new ToolRegistry([])
    expect(registerProductionChildWaitTool({ pool: {} as never, task: { role: "unknown", allowedActions: ["wait_subagents"] }, lease, registry: unknown })).toBe(false)
  })
})

describe("createPrivateSelectedJobToolExecutor", () => {
  it("awaits policy persistence before executing the selected-job tool", async () => {
    const order: string[] = []
    let recordingStarted!: () => void
    let finishRecording!: () => void
    const started = new Promise<void>(resolve => { recordingStarted = resolve })
    const gate = new Promise<void>(resolve => { finishRecording = resolve })
    const { executeTool, createExecutor } = executorFixture()
    const recordPolicyDecision = vi.fn(async (_decision: RuntimePolicyDecision) => {
      order.push("record-start")
      recordingStarted()
      await gate
      order.push("record-finish")
    })

    const pending = createExecutor(recordPolicyDecision)(privateContext(), request)
    await started
    expect(executeTool).not.toHaveBeenCalled()
    finishRecording()

    await expect(pending).resolves.toMatchObject({ status: "completed" })
    expect(order).toEqual(["record-start", "record-finish"])
    expect(executeTool).toHaveBeenCalledOnce()
  })

  it("fails closed when the policy decision cannot be persisted", async () => {
    const { executeTool, createExecutor } = executorFixture()
    const recordPolicyDecision = vi.fn(async (_decision: RuntimePolicyDecision) => {
      throw new Error("policy persistence unavailable")
    })

    await expect(createExecutor(recordPolicyDecision)(privateContext(), request)).rejects.toThrow("policy persistence unavailable")
    expect(recordPolicyDecision).toHaveBeenCalledOnce()
    expect(executeTool).not.toHaveBeenCalled()
  })
})
