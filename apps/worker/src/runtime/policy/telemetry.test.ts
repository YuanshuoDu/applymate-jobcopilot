import { describe, expect, it } from "vitest"

import { InMemoryPolicyDecisionSink } from "./telemetry.js"

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
})
