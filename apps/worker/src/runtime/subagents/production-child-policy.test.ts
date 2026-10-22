import { describe, expect, it } from "vitest"
import type { PolicyEvaluationContext } from "@jobcopilot/agent-policy"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { createProductionChildPolicy, expectedStructuredRole } from "./production-child-policy.js"

const structuredRoles = ["scout", "analyst", "writer", "reviewer", "prepare"] as const
const inheritedMarker = Object.setPrototypeOf(
  { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare" },
  { inherited: true },
)
const scheduledPrepareTool: PolicyEvaluationContext["tool"] = {
  name: "scheduled.application.prepare", version: "1", risk: "draft_write", domain: "resume",
  capabilities: ["read", "write"], requiredCapabilities: [],
}
const durableWaitTool: PolicyEvaluationContext["tool"] = {
  name: "wait_subagents", version: "1", risk: "internal_write", domain: "coordination",
  capabilities: ["coordination"], requiredCapabilities: [],
}

function scheduledPrepareDecision(
  policy: ReturnType<typeof createProductionChildPolicy>,
  overrides: Partial<Pick<PolicyEvaluationContext, "actorRole" | "capabilities" | "tool">> = {},
) {
  return policy.evaluate({
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
    actorRole: "subagent", capabilities: ["read"], tool: scheduledPrepareTool, input: {}, ...overrides,
  })
}

function durableWaitDecision(policy: ReturnType<typeof createProductionChildPolicy>, tool = durableWaitTool) {
  return policy.evaluate({
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
    actorRole: "subagent", capabilities: [], tool, input: {},
  })
}

describe("createProductionChildPolicy scheduled Prepare permission", () => {
  it("allows only the exact scheduled Prepare tool tuple with the read capability", () => {
    const policy = createProductionChildPolicy({
      role: "prepare", taskType: "scheduled_application_prepare", toolPolicySnapshot: undefined,
    }, false)
    expect(scheduledPrepareDecision(policy)).toMatchObject({
      outcome: "allow", reasonCode: "server_scheduled_application_prepare_write",
    })
    for (const tool of [
      { ...scheduledPrepareTool, name: "scheduled.application.prepare.extra" },
      { ...scheduledPrepareTool, version: "2" },
      { ...scheduledPrepareTool, risk: "internal_write" as const },
      { ...scheduledPrepareTool, risk: "read" as const },
      { ...scheduledPrepareTool, domain: "application" as const },
    ]) {
      expect(scheduledPrepareDecision(policy, { tool }).outcome).toBe("deny")
    }
    expect(scheduledPrepareDecision(policy, { capabilities: [] }).outcome).toBe("deny")
    expect(scheduledPrepareDecision(policy, { actorRole: "orchestrator" }).outcome).toBe("deny")

    const otherTaskRole = createProductionChildPolicy({ role: "writer", taskType: "writer", toolPolicySnapshot: undefined }, false)
    expect(scheduledPrepareDecision(otherTaskRole).outcome).toBe("deny")
  })

  it("denies wrong or missing Prepare task types ahead of a configured broad draft-write allow", () => {
    const broadDraftWriteAllow = {
      version: "policy.v1",
      rules: [{
        id: "configured-subagent-draft-write-allow", roles: ["subagent"], risks: ["draft_write"],
        outcome: "allow", reasonCode: "configured_draft_write_allow", reason: "Configured draft-write allow",
      }],
    }
    const exactTaskPolicy = createProductionChildPolicy({
      role: "prepare", taskType: "scheduled_application_prepare", toolPolicySnapshot: broadDraftWriteAllow,
    }, false)
    expect(scheduledPrepareDecision(exactTaskPolicy)).toMatchObject({
      outcome: "allow", reasonCode: "server_scheduled_application_prepare_write",
    })

    const wrongTaskTypePolicy = createProductionChildPolicy({
      role: "prepare", taskType: "other_prepare", toolPolicySnapshot: broadDraftWriteAllow,
    }, false)
    expect(scheduledPrepareDecision(wrongTaskTypePolicy)).toMatchObject({
      outcome: "deny", reasonCode: "server_scheduled_application_prepare_variant_denied",
    })

    const missingTaskTypePolicy = createProductionChildPolicy({
      role: "prepare", toolPolicySnapshot: broadDraftWriteAllow,
    } as unknown as Parameters<typeof createProductionChildPolicy>[0], false)
    expect(scheduledPrepareDecision(missingTaskTypePolicy)).toMatchObject({
      outcome: "deny", reasonCode: "server_scheduled_application_prepare_variant_denied",
    })
  })

  it("keeps configured scheduled Prepare denials ahead of the server exception", () => {
    const policy = createProductionChildPolicy({
      role: "prepare",
      taskType: "scheduled_application_prepare",
      toolPolicySnapshot: {
        version: "policy.v1",
        rules: [{
          id: "configured-scheduled-prepare-deny", roles: ["subagent"], tools: ["scheduled.application.prepare"],
          toolVersions: ["1"], risks: ["draft_write"], domains: ["resume"], requiredCapabilities: ["read"],
          outcome: "deny", reasonCode: "configured_scheduled_prepare_deny", reason: "Configured scheduled Prepare denial",
        }],
      },
    }, false)
    expect(scheduledPrepareDecision(policy)).toMatchObject({
      outcome: "deny", reasonCode: "configured_scheduled_prepare_deny",
    })
  })
})

describe("createProductionChildPolicy durable child wait permission", () => {
  it("keeps the wait-only exception closed while every current child role is not authorized to manage children", () => {
    for (const role of ["scout", "analyst", "prepare", "writer", "reviewer", "auditor", "executor"]) {
      const policy = createProductionChildPolicy({ role, taskType: "research", allowedActions: ["wait_subagents"], toolPolicySnapshot: undefined }, false)
      expect(durableWaitDecision(policy)).toMatchObject({ outcome: "deny", reasonCode: "server_subagent_internal_write_denied" })
      expect(durableWaitDecision(policy, { ...durableWaitTool, name: "agent.wait" }).outcome).toBe("deny")
      expect(durableWaitDecision(policy, { ...durableWaitTool, version: "2" }).outcome).toBe("deny")
      expect(durableWaitDecision(policy, { ...durableWaitTool, domain: "jobs" }).outcome).toBe("deny")
    }
  })

  it("does not grant wait from an alias in persisted allowedActions", () => {
    const policy = createProductionChildPolicy({ role: "scout", taskType: "research", allowedActions: ["agent.wait"], toolPolicySnapshot: undefined }, false)
    expect(durableWaitDecision(policy)).toMatchObject({ outcome: "deny", reasonCode: "server_subagent_internal_write_denied" })
  })

  it("keeps a configured wait denial ahead of a future server-owned exact wait exception", () => {
    const policy = createProductionChildPolicy({
      role: "scout", taskType: "research", toolPolicySnapshot: {
        version: "policy.v1",
        rules: [{ id: "deny-wait", roles: ["subagent"], tools: ["wait_subagents"], outcome: "deny", reasonCode: "configured_wait_deny", reason: "Configured wait denial" }],
      },
    }, false)
    expect(durableWaitDecision(policy)).toMatchObject({ outcome: "deny", reasonCode: "configured_wait_deny" })
  })
})

describe("expectedStructuredRole", () => {
  it.each(structuredRoles)("accepts an exact %s marker", role => {
    expect(expectedStructuredRole({ schemaVersion: ROLE_RESULT_SCHEMA, role }, role)).toBe(role)
  })

  it.each([
    { leasedRole: "unknown", marker: { schemaVersion: ROLE_RESULT_SCHEMA, role: "unknown" } },
    { leasedRole: "prepare", marker: { schemaVersion: "wrong-version", role: "prepare" } },
    { leasedRole: "prepare", marker: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" } },
    { leasedRole: "prepare", marker: { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", extra: true } },
    { leasedRole: "prepare", marker: { schemaVersion: ROLE_RESULT_SCHEMA } },
    { leasedRole: "prepare", marker: null },
    { leasedRole: "prepare", marker: [ROLE_RESULT_SCHEMA, "prepare"] },
    { leasedRole: "prepare", marker: inheritedMarker },
    { leasedRole: "prepare", marker: Object.assign({ schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare" }, { [Symbol("extra")]: true }) },
  ])("rejects invalid marker or role %#", ({ leasedRole, marker }) => {
    expect(expectedStructuredRole(marker, leasedRole)).toBeUndefined()
  })

  it("fails closed when inspecting a marker throws", () => {
    const marker = new Proxy({}, { getPrototypeOf: () => { throw new Error("uninspectable") } })
    expect(expectedStructuredRole(marker, "prepare")).toBeUndefined()
  })
})
