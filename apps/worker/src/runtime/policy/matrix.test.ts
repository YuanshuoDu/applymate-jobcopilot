import { describe, expect, it } from "vitest"

import { createPolicyMatrixHook } from "./matrix.js"
import type { PolicyEvaluationContext } from "./types.js"

const base: PolicyEvaluationContext = {
  scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", toolCallId: "call-a",
  actorRole: "orchestrator", capabilities: ["browser.read"],
  tool: { name: "jobs.search", version: "1", risk: "read", domain: "jobs", capabilities: ["read"], requiredCapabilities: [] },
  input: {},
}

describe("policy matrix hook", () => {
  it("selects the first matching rule deterministically", () => {
    const hook = createPolicyMatrixHook({ version: "policy.v1", rules: [
      { id: "read", roles: ["orchestrator"], risks: ["read"], domains: ["jobs"], outcome: "allow", reasonCode: "read_allowed", reason: "Read allowed" },
      { id: "deny", roles: ["orchestrator"], outcome: "deny", reasonCode: "fallback_deny", reason: "Denied" },
    ] })
    expect(hook.evaluate(base)).toEqual({ outcome: "allow", reasonCode: "read_allowed", reason: "Read allowed" })
  })

  it("requires explicit policy for every write risk", () => {
    const hook = createPolicyMatrixHook()
    expect(hook.evaluate({ ...base, tool: { ...base.tool, risk: "internal_write", capabilities: ["write"] } })).toMatchObject({ outcome: "deny", reasonCode: "missing_policy" })
  })

  it("can constrain a rule to an exact tool version", () => {
    const hook = createPolicyMatrixHook({ version: "policy.v1", rules: [{
      id: "v1-only", roles: ["orchestrator"], tools: ["jobs.search"], toolVersions: ["1"], outcome: "allow", reasonCode: "version_allowed", reason: "Known tool version",
    }] })
    expect(hook.evaluate(base)).toMatchObject({ outcome: "allow" })
    expect(hook.evaluate({ ...base, tool: { ...base.tool, version: "2" } })).toMatchObject({ outcome: "deny", reasonCode: "no_matching_policy" })
  })
})
