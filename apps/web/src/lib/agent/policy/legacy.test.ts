import { describe, expect, it } from "vitest"

import { LegacyPolicyError, evaluateLegacyPolicy, requireLegacyPolicy } from "./legacy"

const base = {
  userId: "user_1",
  sessionId: "session_1",
  turnId: "turn_1",
  stepId: "step_1",
  toolCallId: "call_1",
  toolName: "application.submit",
  domain: "application" as const,
  risk: "external_write" as const,
  capabilities: ["read", "write", "external_write"] as const,
}

describe("legacy entry policy adapter", () => {
  it("applies one policy boundary across all migrated high-risk entry classes", () => {
    const entries = [
      { toolName: "resume.tailor", domain: "resume" as const, risk: "draft_write" as const, capabilities: ["read", "write"] as const },
      { toolName: "application.preflight", domain: "application" as const, risk: "read" as const, capabilities: ["read"] as const },
      { toolName: "gmail.send", domain: "gmail" as const, risk: "external_write" as const, capabilities: ["read", "write", "external_write"] as const },
      { toolName: "automation.mutate", domain: "automation" as const, risk: "internal_write" as const, capabilities: ["read", "write"] as const, input: { requiresReceipt: true } },
    ]

    expect(entries.map(entry => evaluateLegacyPolicy({ ...base, ...entry }).outcome)).toEqual([
      "allow",
      "allow",
      "require_approval",
      "require_approval",
    ])
  })

  it("requires a scoped receipt for external writes", () => {
    expect(evaluateLegacyPolicy(base)).toMatchObject({
      outcome: "require_approval",
      reasonCode: "scoped_receipt_required",
    })
  })

  it("requires an explicit answer when sensitive facts are unknown", () => {
    expect(evaluateLegacyPolicy({
      ...base,
      input: { unknownSensitiveFacts: true, receiptValidated: true },
    })).toMatchObject({
      outcome: "require_user_input",
      reasonCode: "sensitive_fact_confirmation_required",
    })
  })

  it("allows an already validated receipt and exposes a typed failure otherwise", () => {
    expect(requireLegacyPolicy({
      ...base,
      input: { requiresReceipt: true, receiptValidated: true, unknownSensitiveFacts: false },
    })).toMatchObject({ outcome: "allow" })

    expect(() => requireLegacyPolicy(base)).toThrowError(LegacyPolicyError)
  })
})
