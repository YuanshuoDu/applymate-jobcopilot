import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  approvalFindFirst: vi.fn(),
  hashApprovalNonce: vi.fn(async (nonce: string) => `hash:${nonce}`),
  queueAutonomousApplication: vi.fn(),
  requireLegacyPolicy: vi.fn(),
}))
vi.mock("@/lib/api-helpers", () => ({
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
}))
vi.mock("@/lib/db", () => ({ db: { agentApproval: { findFirst: mocks.approvalFindFirst } } }))
vi.mock("@/lib/auto-apply", () => ({ queueAutonomousApplication: mocks.queueAutonomousApplication }))
vi.mock("@jobcopilot/agent-protocol", () => ({ hashApprovalNonce: mocks.hashApprovalNonce }))
vi.mock("@/lib/agent/policy/legacy", () => ({ requireLegacyPolicy: mocks.requireLegacyPolicy }))
import { approvalActionPolicyError, approvalTitle, readBody, replayConsumedSubmitApproval, serializeEvent } from "./support"

describe("session action support", () => {
  beforeEach(() => vi.clearAllMocks())

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

  it("replays an exact consumed submit approval through the read-only path", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({
      payload: { applicationTaskId: "task_1", jobId: "job_1" }, nonceHash: "hash:nonce_1",
    })
    mocks.queueAutonomousApplication.mockResolvedValueOnce({ taskId: "apply-submit-existing" })

    const response = await replayConsumedSubmitApproval({
      sessionId: "session_1", userId: "user_1", approvalId: "approval_1", receiptNonce: "nonce_1",
    })

    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toEqual({ queued: true, taskId: "apply-submit-existing", duplicate: true })
    expect(mocks.approvalFindFirst).toHaveBeenCalledWith({
      where: { id: "approval_1", sessionId: "session_1", userId: "user_1", status: { in: ["approved", "consumed"] }, type: "submit_application" },
      select: { payload: true, nonceHash: true },
    })
    expect(mocks.hashApprovalNonce).toHaveBeenCalledWith("nonce_1")
    expect(mocks.queueAutonomousApplication).toHaveBeenCalledWith({
      userId: "user_1", jobId: "job_1", applyUrl: null, applicationTaskId: "task_1",
      approvalId: "approval_1", receiptNonce: "nonce_1", sessionId: "session_1", replayOnly: true,
    })
  })

  it("does not replay a consumed approval with a different receipt nonce", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({
      payload: { applicationTaskId: "task_1", jobId: "job_1" }, nonceHash: "hash:other",
    })

    await expect(replayConsumedSubmitApproval({
      sessionId: "session_1", userId: "user_1", approvalId: "approval_1", receiptNonce: "nonce_1",
    })).resolves.toBeNull()
    expect(mocks.queueAutonomousApplication).not.toHaveBeenCalled()
  })

  it("returns a conflict when the existing submission intent cannot be resolved", async () => {
    mocks.approvalFindFirst.mockResolvedValueOnce({
      payload: { applicationTaskId: "task_1", jobId: "job_1" }, nonceHash: "hash:nonce_1",
    })
    mocks.queueAutonomousApplication.mockRejectedValueOnce(new Error("intent conflict"))

    const response = await replayConsumedSubmitApproval({
      sessionId: "session_1", userId: "user_1", approvalId: "approval_1", receiptNonce: "nonce_1",
    })
    expect(response?.status).toBe(409)
    await expect(response?.json()).resolves.toEqual({ error: "intent conflict" })
  })

  it("preserves the approval policy input and returns its error response", async () => {
    const approval = {
      id: "approval_1", type: "submit_application", payload: null, turnId: null, toolCallId: null,
      jobId: null, revision: 0, expiresAt: null, resourceHash: null, materialHash: null, answersHash: null,
    }
    expect(approvalActionPolicyError(approval, "approved", false, "user_1", "session_1")).toBeNull()
    expect(mocks.requireLegacyPolicy).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "legacy-approval:approval_1", stepId: "approval:approval_1", toolCallId: "approval:approval_1",
      toolName: "application.submit", risk: "external_write", capabilities: ["read", "write", "external_write"],
      input: { requiresReceipt: true, receiptValidated: false, unknownSensitiveFacts: false },
    }))

    mocks.requireLegacyPolicy.mockImplementationOnce(() => { throw new Error("policy denied") })
    const response = approvalActionPolicyError(approval, "rejected", true, "user_1", "session_1")
    expect(response?.status).toBe(428)
    await expect(response?.json()).resolves.toEqual({ error: "policy denied" })
  })
})
