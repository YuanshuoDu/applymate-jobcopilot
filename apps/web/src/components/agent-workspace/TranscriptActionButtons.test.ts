import { describe, expect, it } from "vitest"
import { transcriptActionErrorText } from "./TranscriptActionButtons"

describe("transcript action button feedback", () => {
  it("uses backend action errors when available", () => {
    expect(transcriptActionErrorText("Approve", new Error("Approval is no longer pending"))).toBe("Approval is no longer pending")
  })

  it("falls back to a clear retry message for unknown failures", () => {
    expect(transcriptActionErrorText("Create automation", null)).toBe("Create automation failed. Please try again.")
  })
})
