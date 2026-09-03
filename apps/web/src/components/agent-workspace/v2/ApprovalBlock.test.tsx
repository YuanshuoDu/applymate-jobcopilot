import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ApprovalBlock } from "./ApprovalBlock"
import type { PendingApproval } from "./types"

const approval: PendingApproval = { approvalId: "approval-1", action: "application.submit", scopeHash: "sha256:scope", expiresAt: "2099-01-01T00:00:00.000Z", evidenceRefs: ["https://example.com/evidence", "artifact:resume-v2"] }

describe("v2 ApprovalBlock", () => {
  it("shows scope, expiry, evidence, and both decision actions", () => {
    const html = renderToStaticMarkup(<ApprovalBlock approval={approval} onApprove={vi.fn()} onDecline={vi.fn()} readOnly={false} />)
    expect(html).toContain("application.submit")
    expect(html).toContain("sha256:scope")
    expect(html).toContain("Approve")
    expect(html).toContain("Decline")
  })

  it("renders safe external evidence links and inert non-URLs", () => {
    const html = renderToStaticMarkup(<ApprovalBlock approval={approval} onApprove={vi.fn()} onDecline={vi.fn()} readOnly={false} />)
    expect(html).toContain('href="https://example.com/evidence"')
    expect(html).toContain("artifact:resume-v2")
  })

  it("removes decision controls after the receipt is answered", () => {
    const html = renderToStaticMarkup(<ApprovalBlock approval={{ ...approval, answeredAt: "2026-09-03T00:00:00.000Z" }} onApprove={vi.fn()} onDecline={vi.fn()} readOnly={false} />)
    expect(html).toContain("Decision already recorded")
    expect(html).not.toContain(">Approve<")
  })
})
