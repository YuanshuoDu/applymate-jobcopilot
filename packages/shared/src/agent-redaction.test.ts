import { describe, expect, it } from "vitest"

import { redactAgentEvent, redactSensitiveValue } from "./agent-redaction"

describe("agent event redaction", () => {
  it("removes credentials and direct PII while preserving opaque receipt references", () => {
    const safe = redactAgentEvent({
      type: "tool_call.completed",
      body: "Sent to recruiter@example.com from Bearer abcdefghijk",
      data: {
        apiKey: "sk-test-secret-value",
        receiptNonce: "nonce-secret",
        recipientEmail: "recruiter@example.com",
        phone: "+353 87 123 4567",
        status: "sent",
      },
    })

    expect(safe).toMatchInlineSnapshot(`
      {
        "body": "Sent to [REDACTED_EMAIL] from Bearer [REDACTED]",
        "data": {
          "apiKey": "[REDACTED]",
          "phone": "[REDACTED]",
          "receiptNonce": "nonce-secret",
          "recipientEmail": "[REDACTED]",
          "status": "sent",
        },
      }
    `)
  })

  it("does not leak sensitive text through arrays or free-form values", () => {
    const safe = redactSensitiveValue([
      "password=super-secret",
      { answer: "My email is candidate@example.com", ok: true },
    ])

    expect(JSON.stringify(safe)).not.toContain("super-secret")
    expect(JSON.stringify(safe)).not.toContain("candidate@example.com")
    expect(safe).toEqual(["password=[REDACTED]", { answer: "[REDACTED]", ok: true }])
  })

  it("keeps safe automation structure available to the transcript UI", () => {
    const safe = redactAgentEvent({
      type: "automation_draft",
      body: "Review the automation before saving it.",
      data: { draft: { name: "Berlin SWE automation", minScore: 85, autoApply: false } },
    })

    expect(safe.data).toEqual({ draft: { name: "Berlin SWE automation", minScore: 85, autoApply: false } })
  })

  it("keeps opaque approval references and omits absent optional values", () => {
    const safe = redactAgentEvent({
      type: "automation_draft",
      body: "Review the automation before saving it.",
      data: {
        draft: { name: "Berlin SWE automation", triggerType: "weekdays" },
        approval: { id: "approval_1", receiptNonce: undefined, scopeHash: "hash_1" },
      },
    })

    expect(safe.data).toEqual({
      draft: { name: "Berlin SWE automation", triggerType: "weekdays" },
      approval: { id: "approval_1", scopeHash: "hash_1" },
    })
  })

  it("keeps resume metadata but removes the resume content", () => {
    const safe = redactAgentEvent({
      type: "resume_tailored",
      body: "A tailored resume is ready.",
      data: { resume: { id: "resume_1", name: "Tailored CV", content: { summary: "private history" } } },
    })

    expect(safe.data).toEqual({ resume: { id: "resume_1", name: "Tailored CV", content: "[REDACTED]" } })
  })
})
