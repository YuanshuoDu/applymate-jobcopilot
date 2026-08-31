import { describe, expect, it } from "vitest"

import { PolicyEngine } from "./engine.js"
import type { PolicyEvaluationContext, PolicySnapshot, PolicyToolDescriptor } from "./types.js"

const readTool: PolicyToolDescriptor = {
  name: "jobs.search",
  version: "1",
  risk: "read",
  domain: "jobs",
  capabilities: ["read"],
  requiredCapabilities: [],
}

const submitTool: PolicyToolDescriptor = {
  name: "application.submit",
  version: "1",
  risk: "external_write",
  domain: "application",
  capabilities: ["external_write"],
  requiredCapabilities: [],
}

function context(tool: PolicyToolDescriptor = readTool, input: unknown = { query: "Berlin" }): PolicyEvaluationContext {
  return {
    scope: { userId: "user_1" },
    sessionId: "session_1",
    turnId: "turn_1",
    stepId: "step_1",
    toolCallId: "call_1",
    actorRole: "orchestrator",
    capabilities: [],
    tool,
    input,
  }
}

const policy: PolicySnapshot = {
  version: "policy.v1",
  rules: [
    {
      id: "jobs-read",
      roles: ["orchestrator"],
      tools: ["jobs.search"],
      risks: ["read"],
      domains: ["jobs"],
      outcome: "allow",
      reasonCode: "jobs_read_allowed",
      reason: "The orchestrator may read job data",
    },
    {
      id: "submit-review",
      roles: ["orchestrator"],
      tools: ["application.submit"],
      risks: ["external_write"],
      domains: ["application"],
      outcome: "require_approval",
      reasonCode: "submit_requires_approval",
      reason: "Submission requires a scoped approval",
    },
  ],
}

describe("shared PolicyEngine", () => {
  it("allows the read baseline but fails closed for write-capable tools without policy", () => {
    const engine = new PolicyEngine()

    expect(engine.evaluate(context()).outcome).toBe("allow")
    expect(engine.evaluate(context(submitTool, { jobId: "job_1" })).outcome).toBe("deny")
  })

  it("applies the same explicit policy outcome and preserves tenant scope", () => {
    const decision = new PolicyEngine({ snapshot: policy }).evaluate(context(submitTool, { jobId: "job_1" }))

    expect(decision).toMatchObject({
      outcome: "require_approval",
      reasonCode: "submit_requires_approval",
      scope: {
        userId: "user_1",
        sessionId: "session_1",
        turnId: "turn_1",
        toolName: "application.submit",
      },
    })
  })

  it("does not allow a different actor role to inherit the orchestrator rule", () => {
    const decision = new PolicyEngine({ snapshot: policy }).evaluate({
      ...context(),
      actorRole: "subagent",
    })

    expect(decision).toMatchObject({ outcome: "deny", reasonCode: "no_matching_policy" })
  })
})
