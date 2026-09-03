import { describe, expect, it } from "vitest"

import { buildGmailApprovalScope } from "./gmail-types.js"

const base = {
  jobId: "job-a", draftId: "draft-a", to: "recruiter@example.com", subject: "Hello",
  draftHash: "a".repeat(64), bodyHash: "b".repeat(64), threadId: "thread-a",
  revision: 1, expiresAt: "2099-01-01T00:00:00.000Z", receiptNonce: "nonce-a",
}

describe("Gmail approval scope", () => {
  it("changes when tenant or approved draft material changes", async () => {
    const first = await buildGmailApprovalScope(base, "user-a", "session-a", "turn-a", "call-a")
    const otherUser = await buildGmailApprovalScope(base, "user-b", "session-a", "turn-a", "call-a")
    const otherDraft = await buildGmailApprovalScope({ ...base, bodyHash: "c".repeat(64) }, "user-a", "session-a", "turn-a", "call-a")
    expect(otherUser).toMatchObject({ userId: "user-b" })
    expect(otherUser.resourceHash).toBe(first.resourceHash)
    expect(otherUser.materialHash).toBe(first.materialHash)
    expect(otherDraft.materialHash).not.toBe(first.materialHash)
    expect(first.answersHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("keeps the scope tied to the origin Turn and one-time receipt", async () => {
    const scope = await buildGmailApprovalScope(base, "user-a", "session-a", "turn-a", "call-a")
    expect(scope).toMatchObject({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", toolCallId: "call-a", action: "send_gmail", revision: 1, nonce: "nonce-a" })
  })
})
