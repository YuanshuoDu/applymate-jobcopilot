import { describe, expect, it, vi } from "vitest"
vi.mock("@/lib/api-helpers", () => ({
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
}))
import { approvalTitle, readBody, serializeEvent } from "./support"

describe("session action support", () => {
  it("normalizes approval responses and supplies the default response body", () => {
    expect(readBody({ type: "approval_response", decision: "cancelled", body: "  " })).toEqual({
      type: "approval_response",
      approvalId: null,
      decision: "cancelled",
      body: "Cancelled the requested action.",
      receiptNonce: null,
    })
    expect(approvalTitle("cancelled")).toBe("Cancelled")
  })

  it("requires a stable request ID for explicit fill retries", () => {
    expect(readBody({ type: "retry_application_fill", applicationTaskId: " task_1 ", requestId: "retry_12345678" })).toEqual({
      type: "retry_application_fill", applicationTaskId: "task_1", requestId: "retry_12345678",
    })
    expect(readBody({ type: "retry_application_fill", applicationTaskId: "task_1", requestId: "short" })).toBeNull()
  })

  it("requires an explicit employer-site attestation for uncertain-submit recovery", () => {
    expect(readBody({ type: "confirm_submission_not_received", applicationTaskId: "task_1", requestId: "confirm_12345678", confirmedNotReceived: true }))
      .toEqual({ type: "confirm_submission_not_received", applicationTaskId: "task_1", requestId: "confirm_12345678", confirmedNotReceived: true })
    expect(readBody({ type: "confirm_submission_not_received", applicationTaskId: "task_1", requestId: "confirm_12345678", confirmedNotReceived: false })).toBeNull()
    expect(readBody({ type: "confirm_submission_not_received", applicationTaskId: "task_1", requestId: "short", confirmedNotReceived: true })).toBeNull()
  })

  it("applies the automation draft defaults and clamps numeric inputs", () => {
    expect(readBody({ type: "create_automation", draft: { name: " Scout ", minScore: 130, dailyCap: 0 } })).toEqual({
      type: "create_automation",
      approvalId: null,
      receiptNonce: null,
      draft: {
        name: "Scout", triggerType: "manual", cron: null, timezone: "Europe/Berlin",
        targetRoles: [], targetLocations: [], minScore: 100, dailyCap: 1,
        requireApproval: true, autoApply: false,
      },
    })
  })

  it("serializes event timestamps as ISO strings", () => {
    expect(serializeEvent({
      id: "event_1", sessionId: "session_1", taskId: null, type: "approval_response", speaker: "You",
      title: "Approved", body: "Approved", data: null, durationMs: null,
      createdAt: new Date("2026-06-18T10:00:00Z"),
    }).createdAt).toBe("2026-06-18T10:00:00.000Z")
  })
})
