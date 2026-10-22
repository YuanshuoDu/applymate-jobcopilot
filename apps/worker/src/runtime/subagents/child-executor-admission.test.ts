import { describe, expect, it } from "vitest"
import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { RuntimeToolDefinition } from "../tools/types.js"
import { canManageChildrenWithWaitAction, visibleChildDefinitions } from "./child-executor-admission.js"
import { createDurableSubagentWaitTool } from "./durable-subagent-wait-tool.js"
import type { SubagentLease } from "./types.js"

const baseLease = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "running", goal: "", constraints: [],
  successCriteria: [], allowedActions: ["wait_subagents"], context: {}, expectedOutputSchema: {}, result: null, failureReason: null,
  attemptCount: 1, maxAttempts: 1, leaseOwner: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null,
  budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
} as Partial<SubagentLease>

function readTool(name = "jobs.search", domain: RuntimeToolDefinition["domain"] = "jobs"): RuntimeToolDefinition {
  return {
    schemaVersion, name, version: "1", description: name, capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: true }),
    outputSchema: Type.Object({}, { additionalProperties: true }), risk: "read", domain, idempotency: "read_only", timeoutMs: 1000,
    requiredCapabilities: ["read"], execute: async () => ({}),
  }
}

describe("child wait admission", () => {
  it("requires the server role policy and exact persisted wait action", () => {
    expect(canManageChildrenWithWaitAction({ canManageChildren: true }, ["wait_subagents"])).toBe(true)
    expect(canManageChildrenWithWaitAction({ canManageChildren: true }, ["agent.wait"])).toBe(false)
    expect(canManageChildrenWithWaitAction({ canManageChildren: false }, ["wait_subagents"])).toBe(false)
    expect(canManageChildrenWithWaitAction(null, ["wait_subagents"])).toBe(false)
    expect(canManageChildrenWithWaitAction({ canManageChildren: true }, "wait_subagents")).toBe(false)
  })

  it("keeps every current role closed and excludes coordination aliases and controls", () => {
    const pool = { connect: async () => { throw new Error("unexpected_wait_execution") } }
    const wait = createDurableSubagentWaitTool(pool as never, baseLease as SubagentLease)
    const coordination = ["spawn_subagent", "agent.spawn", "agent.followup", "send_message", "agent.send", "agent.wait",
      "list_subagents", "agent.list", "interrupt_subagent", "agent.interrupt", "close_subagent", "agent.close"]
      .map(name => ({ ...wait, name }))
    for (const role of ["scout", "analyst", "prepare", "writer", "reviewer", "auditor", "executor"]) {
      const visible = visibleChildDefinitions({ role, allowedActions: ["wait_subagents", "jobs.search", ...coordination.map(tool => tool.name)] }, [wait, ...coordination, readTool()])
      expect(visible.map(tool => tool.name)).not.toContain("wait_subagents")
      expect(visible.some(tool => tool.domain === "coordination")).toBe(false)
    }
    expect(visibleChildDefinitions({ role: "scout", allowedActions: ["jobs.search"] }, [readTool()]).map(tool => tool.name)).toContain("jobs.search")
  })

  it("rejects aliases and wrong versions even when the exact action is persisted", () => {
    const pool = { connect: async () => { throw new Error("unexpected_wait_execution") } }
    const wait = createDurableSubagentWaitTool(pool as never, baseLease as SubagentLease)
    expect(visibleChildDefinitions({ role: "scout", allowedActions: ["agent.wait"] }, [{ ...wait, name: "agent.wait" }])).toEqual([])
    expect(visibleChildDefinitions({ role: "scout", allowedActions: ["wait_subagents"] }, [{ ...wait, version: "2" }])).toEqual([])
    expect(visibleChildDefinitions({ role: "scout", allowedActions: ["wait_subagents"] }, [{ ...wait, capabilities: ["read", "coordination"] }])).toEqual([])
  })
})
