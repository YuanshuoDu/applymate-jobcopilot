import { describe, expect, it, vi } from "vitest"
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

import { registerProductionChildWaitTool } from "./production-child-tools.js"

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
