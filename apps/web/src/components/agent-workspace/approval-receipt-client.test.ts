import { afterEach, describe, expect, it, vi } from "vitest"

import { ensureActionReceipt } from "./approval-receipt-client"

afterEach(() => vi.unstubAllGlobals())

describe("approval receipt reconnect", () => {
  it("refreshes a nonce when a restored action has an approval but no nonce", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ receiptNonce: "fresh_nonce" }))
    vi.stubGlobal("fetch", fetchMock)

    const action = await ensureActionReceipt("session_1", {
      type: "create_automation",
      approvalId: "approval_1",
      receiptNonce: undefined,
    })

    expect(fetchMock).toHaveBeenCalledWith("/api/agent/sessions/session_1/approvals/approval_1")
    expect(action.receiptNonce).toBe("fresh_nonce")
  })

  it("does not rotate an already-present nonce", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const action = await ensureActionReceipt("session_1", {
      type: "create_automation",
      approvalId: "approval_1",
      receiptNonce: "existing_nonce",
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(action.receiptNonce).toBe("existing_nonce")
  })
})
