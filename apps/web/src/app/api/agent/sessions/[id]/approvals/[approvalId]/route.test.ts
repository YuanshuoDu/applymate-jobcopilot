import { beforeEach, describe, expect, it, vi } from "vitest"
import { AgentWaitError } from "@/lib/agent/broker/errors"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  decideApproval: vi.fn(),
  reissueApprovalNonce: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/broker/store", () => ({ decideApproval: mocks.decideApproval }))
vi.mock("@/lib/agent/approval/legacy-receipt", () => ({ reissueApprovalNonce: mocks.reissueApprovalNonce }))

const context = { params: Promise.resolve({ id: "session_1", approvalId: "approval_1" }) }

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/agent/sessions/session_1/approvals/approval_1", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("approval decision command API", () => {
  beforeEach(() => {
    mocks.requireAuth.mockReset()
    mocks.decideApproval.mockReset()
    mocks.reissueApprovalNonce.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.decideApproval.mockResolvedValue({ waitKind: "approval", waitId: "approval_1", disposition: "resolved", status: "approved", turnId: "turn_1", itemId: "item_1", toolCallId: "call_1", nextTurnRevision: 6, sequence: "12" })
    mocks.reissueApprovalNonce.mockResolvedValue({ approvalId: "approval_1", receiptNonce: "nonce_1", scopeHash: "a".repeat(64), expiresAt: "2026-09-01T00:00:00.000Z" })
  })

  it("reissues a scoped nonce without exposing it in the transcript", async () => {
    const { GET } = await import("./route")
    const response = await GET(request({}) as never, context)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ approvalId: "approval_1", receiptNonce: "nonce_1" }))
    expect(mocks.reissueApprovalNonce).toHaveBeenCalledWith(expect.anything(), { approvalId: "approval_1", sessionId: "session_1", userId: "user_1" })
  })

  it("accepts a typed decision with the authenticated owner and expected revision", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "decision_1", expectedTurnId: "turn_1", expectedRevision: 5, decision: "approved" }) as never, context)

    expect(response.status).toBe(202)
    expect(mocks.decideApproval).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "session_1", userId: "user_1", waitId: "approval_1", expectedRevision: 5, decision: "approved" }))
  })

  it("rejects client-supplied ownership or payload fields before the broker", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "unsafe", expectedTurnId: "turn_1", expectedRevision: 5, decision: "approved", userId: "other", payload: { submit: true } }) as never, context)

    expect(response.status).toBe(422)
    expect(mocks.decideApproval).not.toHaveBeenCalled()
  })

  it("maps broker scope and revision conflicts", async () => {
    mocks.decideApproval.mockRejectedValueOnce(new AgentWaitError("wait_revision_mismatch", "stale", 409, { expected: 5, actual: 6 }))
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "stale", expectedTurnId: "turn_1", expectedRevision: 5, decision: "rejected" }) as never, context)

    expect(response.status).toBe(409)
  })
})
