import { describe, expect, it } from "vitest"

import type { RuntimePolicyDecision } from "@jobcopilot/agent-policy"
import { PolicyDecisionSchema, validate } from "@jobcopilot/agent-protocol"

import { durablePolicyDecisionProjection, InMemoryPolicyDecisionSink } from "./telemetry.js"

const owner = {
  kind: "turn" as const, userId: "server-user", sessionId: "server-session", turnId: "server-turn",
  taskId: "root-task", rootTaskId: "root-task", ownerId: "worker-a", leaseVersion: 3,
  leaseExpiresAt: new Date("2026-10-23T00:00:00.000Z"),
}

function decision(overrides: Partial<RuntimePolicyDecision> = {}): RuntimePolicyDecision {
  return {
    schemaVersion: "agent-harness.v2", policyVersion: "policy.v1", hook: "before_tool_use", outcome: "allow",
    reasonCode: "read_allowed", reason: "Read is allowed", appliedHooks: ["policy-matrix"], safeInput: { private: "requested" },
    scope: {
      userId: "untrusted-user", sessionId: "untrusted-session", turnId: "untrusted-turn", stepId: "step-1",
      toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", role: "orchestrator", domain: "jobs", risk: "read",
    },
    ...overrides,
  }
}

describe("policy decision telemetry", () => {
  it("stores replayable decisions without runtime-only rewritten input", () => {
    const sink = new InMemoryPolicyDecisionSink()
    sink.append({
      schemaVersion: "agent-harness.v2", policyVersion: "policy.v1", hook: "before_tool_use", outcome: "allow",
      reasonCode: "read_allowed", reason: "Read is allowed", scope: {
        userId: "user-a", sessionId: "session-a", turnId: "turn-a", stepId: "step-a", toolCallId: "call-a",
        toolName: "jobs.search", toolVersion: "1", role: "orchestrator", domain: "jobs", risk: "read",
      },
    })
    expect(sink.replay()).toEqual(sink.decisions)
    expect(sink.replay()[0]).not.toHaveProperty("safeInput")
  })

  it("projects only the strict protocol decision and derives tenant identity from the owner", () => {
    const projected = durablePolicyDecisionProjection(decision(), owner)

    expect(validate(PolicyDecisionSchema, projected)).toBe(true)
    expect(projected.scope).toMatchObject({ userId: "server-user", sessionId: "server-session", turnId: "server-turn" })
    expect(projected).not.toHaveProperty("safeInput")
    expect(projected).not.toHaveProperty("appliedHooks")
  })

  it("redacts and bounds free-form decision reasons before protocol validation", () => {
    const raw = `Contact steven@example.com at +353 87 123 4567 with sk-live-secret-value ${"x".repeat(700)}`
    const projected = durablePolicyDecisionProjection(decision({ reason: raw, reasonCode: raw }), owner)

    expect(projected.reason).not.toContain("steven@example.com")
    expect(projected.reason).not.toContain("+353 87 123 4567")
    expect(projected.reason).not.toContain("sk-live-secret-value")
    expect(projected.reason).toHaveLength(512)
    expect(projected.reasonCode).toHaveLength(256)
    expect(validate(PolicyDecisionSchema, projected)).toBe(true)
  })

  it("rejects non-terminal or non-tool policy decisions", () => {
    expect(() => durablePolicyDecisionProjection(decision({ outcome: "rewrite_input" }), owner)).toThrow("policy_decision_projection_invalid")
    expect(() => durablePolicyDecisionProjection(decision({ hook: "before_model_call" }), owner)).toThrow("policy_decision_projection_invalid")
  })
})
