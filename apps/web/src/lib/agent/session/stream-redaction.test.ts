import { describe, expect, it } from "vitest"

import { redactStreamString, redactStreamValue } from "./stream-redaction"

describe("agent stream redaction", () => {
  it("redacts credential-shaped strings", () => {
    expect(redactStreamString("Bearer very-secret-token sk-12345678")).toBe("Bearer [REDACTED] [REDACTED]")
  })

  it("redacts nested credential, resume, and raw payload keys", () => {
    expect(redactStreamValue({ data: { token: "private", resume: "full CV", rawContent: "raw" }, title: "safe" })).toEqual({
      data: { token: "[REDACTED]", resume: "[REDACTED]", rawContent: "[REDACTED]" }, title: "safe",
    })
  })
})
