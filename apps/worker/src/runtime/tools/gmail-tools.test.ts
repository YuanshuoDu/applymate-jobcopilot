import { describe, expect, it, vi } from "vitest"

import { buildGmailApprovalScope, type GmailToolOptions } from "./gmail-types.js"
import { createGmailTools } from "./gmail-tools.js"

function context(userId = "user-a") {
  return { scope: { userId }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", toolCallId: "call-a", signal: new AbortController().signal, capabilities: [], reportProgress: vi.fn(async () => {}) }
}

function options(overrides: Partial<GmailToolOptions> = {}): GmailToolOptions {
  return {
    credentials: { getAccessToken: vi.fn(async () => ({ accessToken: "opaque-token", scope: "https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send" })) },
    client: { getThread: vi.fn(async () => ({ threadId: "thread-a", messages: [] })), createDraft: vi.fn(async () => ({ draftId: "draft-a", messageId: "message-a", threadId: "thread-a" })), sendDraft: vi.fn(async () => ({ messageId: "sent-a", threadId: "thread-a" })) },
    approvals: () => ({ consumeAndReserve: vi.fn(async () => ({ approvalId: "approval-a", reservationId: "reservation-a", consumedAt: new Date() })) }),
    evidence: { findSendEvidence: vi.fn(async () => null), hasSendReservation: vi.fn(async () => false), persistSendEvidence: vi.fn(async (input) => ({ evidenceId: "evidence-a", messageId: input.messageId, threadId: input.threadId, jobId: input.jobId, idempotencyKey: input.idempotencyKey, tracked: true })) },
    oauth: { suspend: vi.fn(async () => ({ waitId: "wait-a", reconnectUrl: "/api/gmail/oauth/start?agentWaitId=wait-a" })) },
    ...overrides,
  }
}

const draft = { idempotencyKey: "draft-key", jobId: "job-a", to: "recruiter@example.com", subject: "Hello", body: "Thank you", threadId: "thread-a" }

async function sendInput(userId = "user-a") {
  const input = { idempotencyKey: "send-key", jobId: "job-a", draftId: "draft-a", to: "recruiter@example.com", subject: "Hello", draftHash: "a".repeat(64), bodyHash: "b".repeat(64), threadId: "thread-a", approvalId: "approval-a", receiptNonce: "nonce-a", revision: 0, expiresAt: "2099-01-01T00:00:00.000Z" }
  const scope = await buildGmailApprovalScope(input, userId, "session-a", "turn-a", "call-a")
  return { input, scope }
}

describe("Agent Gmail typed tools", () => {
  it("keeps draft creation separate and never calls the send adapter", async () => {
    const tested = options()
    const [get, create, send] = createGmailTools(tested)
    expect([get.name, create.name, send.name]).toEqual(["gmail.get_thread", "gmail.create_draft", "gmail.send"])
    await expect(create.execute(context(), draft)).resolves.toMatchObject({ status: "drafted", draftId: "draft-a", messageId: "message-a" })
    expect(tested.client.sendDraft).not.toHaveBeenCalled()
  })

  it("does not send without a valid approval receipt and never calls Gmail", async () => {
    const tested = options({ approvals: () => ({ consumeAndReserve: vi.fn(async () => { throw Object.assign(new Error("not approved"), { code: "approval_not_approved" }) }) }) })
    const [, , send] = createGmailTools(tested)
    const { input } = await sendInput()
    await expect(send.execute(context(), input)).rejects.toMatchObject({ code: "approval_not_approved" })
    expect(tested.client.sendDraft).not.toHaveBeenCalled()
  })

  it("binds approval scope to the runtime tenant and exact draft material", async () => {
    const consume = vi.fn(async () => ({ approvalId: "approval-a", reservationId: "reservation-a", consumedAt: new Date() }))
    const tested = options({ approvals: () => ({ consumeAndReserve: consume }) })
    const [, , send] = createGmailTools(tested)
    const { input, scope } = await sendInput("user-a")
    await send.execute(context("user-a"), input)
    expect(consume).toHaveBeenCalledWith(input.approvalId, expect.objectContaining({ userId: "user-a", sessionId: "session-a", turnId: "turn-a", toolCallId: "call-a", resourceHash: scope.resourceHash, materialHash: scope.materialHash, answersHash: scope.answersHash }), input.idempotencyKey)
    expect(tested.credentials.getAccessToken).toHaveBeenCalledWith("user-a")
  })

  it("returns persisted evidence on duplicate delivery without a second provider call", async () => {
    const tested = options({ evidence: { findSendEvidence: vi.fn(async () => ({ evidenceId: "evidence-old", messageId: "sent-old", threadId: "thread-old", jobId: "job-a", idempotencyKey: "send-key", tracked: true })), hasSendReservation: vi.fn(async () => true), persistSendEvidence: vi.fn() } })
    const [, , send] = createGmailTools(tested)
    const { input } = await sendInput()
    await expect(send.execute(context(), input)).resolves.toEqual({ status: "duplicate", messageId: "sent-old", threadId: "thread-old", evidenceId: "evidence-old", tracked: true, jobId: "job-a" })
    expect(tested.client.sendDraft).not.toHaveBeenCalled()
  })

  it("suspends the same origin Turn for OAuth and exposes no token", async () => {
    const suspend = vi.fn(async () => ({ waitId: "wait-a", reconnectUrl: "/api/gmail/oauth/start?agentWaitId=wait-a" }))
    const tested = options({ credentials: { getAccessToken: vi.fn(async () => null) }, oauth: { suspend } })
    const [, , send] = createGmailTools(tested)
    const { input } = await sendInput()
    await expect(send.execute(context(), input)).rejects.toMatchObject({ code: "gmail_oauth_required", safeOutput: { status: "waiting_for_oauth", waitId: "wait-a" } })
    expect(suspend).toHaveBeenCalledWith(expect.objectContaining({ reason: "gmail_reauthorization_required", context: expect.objectContaining({ sessionId: "session-a", turnId: "turn-a" }) }))
    expect(JSON.stringify(suspend.mock.calls)).not.toContain("opaque-token")
  })

  it("rejects a send-scoped credential without gmail.send", async () => {
    const tested = options({ credentials: { getAccessToken: vi.fn(async () => ({ accessToken: "opaque-token", scope: "https://www.googleapis.com/auth/gmail.readonly" })) } })
    const [, , send] = createGmailTools(tested)
    const { input } = await sendInput()
    await expect(send.execute(context(), input)).rejects.toMatchObject({ code: "gmail_scope_denied" })
    expect(tested.client.sendDraft).not.toHaveBeenCalled()
  })
})
