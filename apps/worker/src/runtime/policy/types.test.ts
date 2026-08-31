import { describe, expect, it } from "vitest"

import { policyScope } from "./types.js"

describe("policy contracts", () => {
  it("builds scope only from runtime-owned context", () => {
    expect(policyScope({
      scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", toolCallId: "call-a",
      actorRole: "subagent", capabilities: [], tool: { name: "persona.retrieve", version: "1", risk: "read", domain: "persona", capabilities: ["read"], requiredCapabilities: [] }, input: { userId: "ignored" },
    })).toEqual({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", stepId: "step-a", toolCallId: "call-a", toolName: "persona.retrieve", toolVersion: "1", role: "subagent", domain: "persona", risk: "read" })
  })
})
