import { describe, expect, it } from "vitest"
import type { PolicyEvaluationContext, PolicyToolDescriptor, PolicySnapshot } from "@jobcopilot/agent-policy"

import { createCanonicalPolicy } from "./canonical-policy.js"

const coordinationTool: PolicyToolDescriptor = {
  name: "spawn_subagent", version: "1", risk: "internal_write", domain: "coordination", capabilities: ["coordination"], requiredCapabilities: ["canManageChildren"],
}
const coordinationReadTool: PolicyToolDescriptor = {
  name: "list_subagents", version: "1", risk: "read", domain: "coordination", capabilities: ["read", "coordination"], requiredCapabilities: ["canManageChildren"],
}
const planningTool: PolicyToolDescriptor = {
  name: "agent.plan.propose", version: "1", risk: "internal_write", domain: "coordination", capabilities: ["coordination"], requiredCapabilities: ["canPlan"],
}
const readTool: PolicyToolDescriptor = { name: "jobs.search", version: "1", risk: "read", domain: "jobs", capabilities: ["read"], requiredCapabilities: [] }
const writeTool: PolicyToolDescriptor = { name: "application.submit", version: "1", risk: "external_write", domain: "application", capabilities: ["external_write"], requiredCapabilities: [] }

function context(tool: PolicyToolDescriptor, capabilities = ["read", "canManageChildren"]): PolicyEvaluationContext {
  return {
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1", actorRole: "orchestrator", capabilities, tool, input: {},
  }
}

describe("canonical root policy", () => {
  it("allows gated coordination and keeps the safe read baseline", () => {
    const policy = createCanonicalPolicy({}, true)
    expect(policy.evaluate(context(coordinationTool))).toMatchObject({ outcome: "allow", reasonCode: "server_coordination_gate" })
    expect(policy.evaluate(context(coordinationReadTool))).toMatchObject({ outcome: "allow", reasonCode: "server_coordination_read_gate" })
    expect(policy.evaluate(context(readTool))).toMatchObject({ outcome: "allow", reasonCode: "safe_read_baseline" })
  })

  it("denies non-coordination writes under the fallback", () => {
    expect(createCanonicalPolicy({}, true).evaluate(context(writeTool))).toMatchObject({ outcome: "deny" })
  })

  it("preserves an explicit policy denial and does not fallback over it", () => {
    const explicit: PolicySnapshot = { version: "policy.v1", rules: [{ id: "deny-coordination", roles: ["orchestrator"], domains: ["coordination"], outcome: "deny", reasonCode: "explicit_deny", reason: "Coordination is disabled by policy" }] }
    expect(createCanonicalPolicy(explicit, true).evaluate(context(coordinationTool))).toMatchObject({ outcome: "deny", reasonCode: "explicit_deny" })
  })

  it("keeps coordination denied when the server gate is off", () => {
    expect(createCanonicalPolicy({}, false).evaluate(context(coordinationTool))).toMatchObject({ outcome: "deny", reasonCode: "missing_policy" })
  })

  it("allows planning only with the planning gate and derived capability", () => {
    expect(createCanonicalPolicy({}, false, true).evaluate(context(planningTool, ["read", "canPlan"]))).toMatchObject({ outcome: "allow", reasonCode: "server_planning_gate" })
    expect(createCanonicalPolicy({}, true, false).evaluate(context(planningTool))).toMatchObject({ outcome: "deny" })
  })

  it("fails closed for a present but malformed snapshot instead of falling back", () => {
    expect(() => createCanonicalPolicy({ version: "policy.v1" }, true)).toThrow()
    expect(() => createCanonicalPolicy({ rules: [] }, true)).toThrow()
  })

  it("treats existing runtime metadata as missing policy without granting it authority", () => {
    for (const metadata of [{ capabilities: ["read"] }, { role: "orchestrator" }]) {
      expect(createCanonicalPolicy(metadata, true).evaluate(context(coordinationTool))).toMatchObject({ outcome: "allow" })
      expect(createCanonicalPolicy(metadata, false).evaluate(context(coordinationTool))).toMatchObject({ outcome: "deny", reasonCode: "missing_policy" })
    }
  })
})
