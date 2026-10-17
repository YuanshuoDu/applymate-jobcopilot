import { describe, expect, it } from "vitest"

import { projectFinalSummary } from "./final-summary-projection"

describe("projectFinalSummary", () => {
  it("projects only the approved summary from live nested final content", () => {
    expect(projectFinalSummary("agent_message", "final_answer", "completed", {
      text: "unchanged answer",
      final: { summary: "Verified two facts.", goal: "PRIVATE_GOAL", evidenceRefs: ["PRIVATE_REF"], usage: { tokens: 12 } },
    })).toBe("Verified two facts.")
  })

  it("accepts the bounded flat summary projected for replay", () => {
    const summary = "x".repeat(1_000)
    expect(projectFinalSummary("agent_message", "final_answer", "completed", { text: "answer", summary })).toBe(summary)
  })

  it("keeps the legacy generic final summary valid", () => {
    expect(projectFinalSummary("agent_message", "final_answer", "completed", {
      text: "answer", final: { summary: "The Turn goal was completed with verified evidence." },
    })).toBe("The Turn goal was completed with verified evidence.")
    expect(projectFinalSummary("agent_message", "final_answer", "completed", { text: "answer", final: {} })).toBeUndefined()
  })

  it("uses shared stream redaction for contact data, credentials, and assignments", () => {
    expect(projectFinalSummary("agent_message", "final_answer", "completed", {
      final: { summary: "Contact alex@example.test +353 871234567; Bearer summary-token; password=private-value;" },
    })).toBe("Contact [REDACTED_EMAIL] [REDACTED_PHONE]; Bearer [REDACTED]; password=[REDACTED];")
  })

  it("rejects summaries whose shared redaction would exceed the length cap", () => {
    const shortAssignments = "password=x;".repeat(80)
    expect(shortAssignments.length).toBeLessThanOrEqual(1_000)
    expect(projectFinalSummary("agent_message", "final_answer", "completed", {
      final: { summary: shortAssignments },
    })).toBeUndefined()
  })

  it("rejects malformed, oversized, blank, or non-final summary metadata", () => {
    const oversized = { final: { summary: "x".repeat(1_001) } }
    const malformed = [null, [], "summary", { final: null }, { final: { summary: 7 } }, { final: { summary: "   " } }, oversized]
    for (const content of malformed) {
      expect(projectFinalSummary("agent_message", "final_answer", "completed", content)).toBeUndefined()
    }
    expect(projectFinalSummary("agent_message", "commentary", "completed", { final: { summary: "private" } })).toBeUndefined()
    expect(projectFinalSummary("agent_message", "final_answer", "running", { final: { summary: "private" } })).toBeUndefined()
    expect(projectFinalSummary("tool_result", "final_answer", "completed", { final: { summary: "private" } })).toBeUndefined()
  })

  it("does not fall back to a flat field when nested final metadata is malformed", () => {
    expect(projectFinalSummary("agent_message", "final_answer", "completed", {
      summary: "PRIVATE_FALLBACK", final: { summary: null },
    })).toBeUndefined()
  })
})
