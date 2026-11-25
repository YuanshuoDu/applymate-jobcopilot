import { describe, expect, it } from "vitest"

import { redactJobReadOutput } from "./task-graph-job-read-redaction.js"

describe("shared TaskGraph job-read redaction", () => {
  it("preserves only the exact jobs.get identifier path", () => {
    const id = "00000000-0000-4000-8000-000000000000"
    expect(redactJobReadOutput("jobs.get", { job: { id, title: "Engineer", contact: "person@example.com" }, id }))
      .toEqual({ job: { id, title: "Engineer", contact: "[REDACTED_EMAIL]" }, id: "[REDACTED_PHONE]" })
  })

  it("fails closed for an unsupported output shape", () => {
    expect(redactJobReadOutput("jobs.get", { job: { id: "not-a-canonical-id" } })).toBe("[REDACTED]")
  })
})
