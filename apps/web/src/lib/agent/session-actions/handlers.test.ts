import { beforeEach, describe, expect, it, vi } from "vitest"
import { hashApprovalNonce, hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { protocolScope, type ApprovalScopeInput } from "../approval/types"

vi.mock("@/lib/api-helpers", () => ({
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
}))

const mocks = vi.hoisted(() => ({
  applicationFillTaskGraphEnabled: vi.fn(),
  assertActiveAccount: vi.fn(),
  assertUnattendedApplyEnabled: vi.fn(),
  validateAutoApplyUrl: vi.fn(),
  assertJobPreflight: vi.fn(),
  applicationTaskFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  jobUpdate: vi.fn(),
  resumeFindFirst: vi.fn(),
  transaction: vi.fn(),
  sourceFence: vi.fn(),
  eventCreate: vi.fn(),
  updateSession: vi.fn(),
  order: [] as string[],
  tx: {
    resume: { findFirst: vi.fn() },
    job: { findFirst: vi.fn(), update: vi.fn() },
  },
  approvalFindFirst: vi.fn(),
  queueApplicationFill: vi.fn(),
  confirmSubmissionNotReceived: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    applicationTask: { findFirst: mocks.applicationTaskFindFirst },
    resume: { findFirst: mocks.resumeFindFirst },
    job: { findFirst: mocks.jobFindFirst, update: mocks.jobUpdate },
    agentApproval: { findFirst: mocks.approvalFindFirst },
    agentTranscriptEvent: { create: mocks.eventCreate },
  },
}))

vi.mock("@/lib/agent/source-material-fence", () => ({ acquireSourceMaterialFence: mocks.sourceFence }))
vi.mock("@/lib/agent/session/repository", () => ({ updateAgentSession: mocks.updateSession }))

vi.mock("@/lib/auto-apply", () => ({
  applicationFillTaskGraphEnabled: mocks.applicationFillTaskGraphEnabled,
  queueApplicationFill: mocks.queueApplicationFill,
}))
vi.mock("@/lib/auto-apply-guards", () => ({
  assertActiveAccount: mocks.assertActiveAccount,
  assertUnattendedApplyEnabled: mocks.assertUnattendedApplyEnabled,
  validateAutoApplyUrl: mocks.validateAutoApplyUrl,
  assertJobPreflight: mocks.assertJobPreflight,
}))
vi.mock("../control-plane/commands/application-submission-recovery-command", () => ({
  confirmSubmissionNotReceived: mocks.confirmSubmissionNotReceived,
}))

import { handleConfirmSubmissionNotReceivedAction, handleConfirmedTailoredResume, handleRetryApplicationFillAction, validateReceiptForApproval } from "./handlers"

describe("session action handlers", () => {
  beforeEach(() => {
    mocks.applicationFillTaskGraphEnabled.mockReset().mockReturnValue(false)
    mocks.assertActiveAccount.mockReset().mockResolvedValue(undefined)
    mocks.assertUnattendedApplyEnabled.mockReset().mockResolvedValue(undefined)
    mocks.validateAutoApplyUrl.mockReset().mockReturnValue("https://jobs.example/apply")
    mocks.assertJobPreflight.mockReset().mockResolvedValue(undefined)
    mocks.applicationTaskFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.jobUpdate.mockReset()
    mocks.resumeFindFirst.mockReset()
    mocks.transaction.mockReset()
    mocks.sourceFence.mockReset()
    mocks.eventCreate.mockReset()
    mocks.updateSession.mockReset()
    mocks.tx.resume.findFirst.mockReset()
    mocks.tx.job.findFirst.mockReset()
    mocks.tx.job.update.mockReset()
    mocks.order.length = 0
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      mocks.order.push("transaction")
      const result = await callback(mocks.tx)
      mocks.order.push("transaction-finished")
      return result
    })
    mocks.sourceFence.mockImplementation(async () => { mocks.order.push("fence") })
    mocks.tx.resume.findFirst.mockImplementation(async () => { mocks.order.push("resume-read"); return null })
    mocks.tx.job.findFirst.mockImplementation(async () => { mocks.order.push("job-read"); return null })
    mocks.tx.job.update.mockImplementation(async () => { mocks.order.push("job-write"); return {} })
    mocks.eventCreate.mockImplementation(async ({ data }: { data: unknown }) => {
      mocks.order.push("event-create")
      return { id: "event_1", sessionId: "session_1", taskId: null, type: "resume_finalized", speaker: "Reviewer", title: "Application pack ready", body: "ready", data, durationMs: null, createdAt: new Date("2026-01-01T00:00:00.000Z") }
    })
    mocks.updateSession.mockImplementation(async () => { mocks.order.push("session-update") })
    mocks.queueApplicationFill.mockReset()
    mocks.confirmSubmissionNotReceived.mockReset()
    mocks.approvalFindFirst.mockReset()
  })

  it("fences and re-reads the exact tailored resume and owned job before updating the final pointer", async () => {
    mocks.tx.resume.findFirst.mockImplementationOnce(async () => { mocks.order.push("resume-read"); return { id: "resume_1", name: "Tailored resume" } })
    mocks.tx.job.findFirst.mockImplementationOnce(async () => { mocks.order.push("job-read"); return { id: "job_1", company: "Acme", role: "Engineer", url: "https://jobs.example/apply", status: "saved" } })

    const response = await handleConfirmedTailoredResume("session_1", "user_1", {
      id: "approval_1", type: "confirm_tailored_resume", payload: { resumeId: "resume_1", jobId: "job_1" },
      turnId: null, toolCallId: null, jobId: "job_1", revision: 0, expiresAt: null,
      resourceHash: null, materialHash: null, answersHash: null,
    })

    expect(response.status).toBe(200)
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ["user_1"])
    expect(mocks.tx.resume.findFirst).toHaveBeenCalledWith({
      where: { id: "resume_1", userId: "user_1", targetJobId: "job_1" }, select: { id: true, name: true },
    })
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({
      where: { id: "job_1", userId: "user_1" }, select: { id: true, company: true, role: true, url: true, status: true },
    })
    expect(mocks.tx.job.update).toHaveBeenCalledWith({
      where: { id: "job_1", userId: "user_1" },
      data: expect.objectContaining({ finalResumeId: "resume_1", status: "saved", workflowState: "ready_to_apply" }),
    })
    expect(mocks.jobUpdate).not.toHaveBeenCalled()
    expect(mocks.order).toEqual([
      "transaction", "fence", "resume-read", "job-read", "job-write", "transaction-finished", "event-create", "session-update",
    ])
    expect(mocks.updateSession).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "session_1", status: "completed", completedAt: expect.any(Date),
    })
  })

  it("preserves not-found priority and performs no final pointer write when the scoped source is missing", async () => {
    mocks.tx.job.findFirst.mockImplementationOnce(async () => { mocks.order.push("job-read"); return { id: "job_1", status: "applied" } })

    const response = await handleConfirmedTailoredResume("session_1", "user_1", {
      id: "approval_1", type: "confirm_tailored_resume", payload: { resumeId: "resume_wrong_job", jobId: "job_1" },
      turnId: null, toolCallId: null, jobId: "job_1", revision: 0, expiresAt: null,
      resourceHash: null, materialHash: null, answersHash: null,
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "The tailored resume or job is no longer available." })
    expect(mocks.tx.resume.findFirst).toHaveBeenCalledWith({
      where: { id: "resume_wrong_job", userId: "user_1", targetJobId: "job_1" }, select: { id: true, name: true },
    })
    expect(mocks.order).toEqual(["transaction", "fence", "resume-read", "job-read", "transaction-finished"])
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it("keeps the submitted-job conflict and avoids all writes", async () => {
    mocks.tx.resume.findFirst.mockImplementationOnce(async () => { mocks.order.push("resume-read"); return { id: "resume_1", name: "Tailored resume" } })
    mocks.tx.job.findFirst.mockImplementationOnce(async () => { mocks.order.push("job-read"); return { id: "job_1", status: "applied" } })

    const response = await handleConfirmedTailoredResume("session_1", "user_1", {
      id: "approval_1", type: "confirm_tailored_resume", payload: { resumeId: "resume_1", jobId: "job_1" },
      turnId: null, toolCallId: null, jobId: "job_1", revision: 0, expiresAt: null,
      resourceHash: null, materialHash: null, answersHash: null,
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "This job has already been submitted." })
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it("validates canonical submission receipts with the stored hashes and rejects a wrong nonce when answers exist", async () => {
    const nonce = "canonical-submit-nonce"
    const nonceHash = await hashApprovalNonce(nonce)
    const expiresAt = new Date(Date.now() + 60_000)
    const scope: ApprovalScopeInput = {
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", jobId: "job_1", toolCallId: "application-submit:task_1",
      action: "submit_application", resourceHash: "sha256:" + "a".repeat(64), materialHash: "sha256:" + "b".repeat(64),
      answersHash: await hashAgentReceiptValue("answers", { eligible: "yes" }), revision: 4, expiresAt,
    }
    const row = {
      id: "approval_1", ...scope, type: "submit_application", status: "pending", payload: { applicationTaskId: "task_1", jobId: "job_1" },
      nonceHash, scopeHash: await hashApprovalScope(protocolScope(scope, nonceHash)),
      createdAt: new Date(), decidedAt: null, consumedAt: null,
    }
    mocks.approvalFindFirst.mockResolvedValue(row)

    await expect(validateReceiptForApproval({
      id: row.id, type: row.type, payload: row.payload, turnId: scope.turnId, toolCallId: scope.toolCallId, jobId: scope.jobId,
      revision: scope.revision, expiresAt, resourceHash: scope.resourceHash, materialHash: scope.materialHash, answersHash: scope.answersHash,
    }, nonce, scope.userId, scope.sessionId)).resolves.toBeUndefined()

    await expect(validateReceiptForApproval({
      id: row.id, type: row.type, payload: row.payload, turnId: scope.turnId, toolCallId: scope.toolCallId, jobId: scope.jobId,
      revision: scope.revision, expiresAt, resourceHash: scope.resourceHash, materialHash: scope.materialHash, answersHash: scope.answersHash,
    }, "wrong-nonce", scope.userId, scope.sessionId)).rejects.toMatchObject({ code: "approval_nonce_mismatch" })
    expect(mocks.approvalFindFirst).toHaveBeenCalledWith({ where: { id: row.id, userId: scope.userId } })
  })

  it("keeps explicit fill retries unavailable when the feature is disabled", async () => {
    const response = await handleRetryApplicationFillAction("session_1", "user_1", {
      type: "retry_application_fill", applicationTaskId: "task_1", requestId: "retry_12345678",
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "Explicit TaskGraph fill retry is unavailable while the feature is disabled" })
    expect(mocks.applicationTaskFindFirst).not.toHaveBeenCalled()
  })

  it("scopes a retry to the user and session and forwards its idempotency key", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.applicationTaskFindFirst.mockResolvedValueOnce({ id: "task_1", jobId: "job_1" })
    mocks.jobFindFirst.mockResolvedValueOnce({ url: "https://jobs.example/apply" })
    mocks.queueApplicationFill.mockResolvedValueOnce({ turnId: "turn_fill_1", disposition: "started" })

    const response = await handleRetryApplicationFillAction("session_1", "user_1", {
      type: "retry_application_fill", applicationTaskId: "task_1", requestId: "retry_12345678",
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ turnId: "turn_fill_1", disposition: "started", retried: true })
    expect(mocks.applicationTaskFindFirst).toHaveBeenCalledWith({
      where: { id: "task_1", userId: "user_1", sessionId: "session_1" }, select: { id: true, jobId: true },
    })
    expect(mocks.queueApplicationFill).toHaveBeenCalledWith({
      userId: "user_1", jobId: "job_1", applyUrl: "https://jobs.example/apply", applicationTaskId: "task_1",
      sessionId: "session_1", retry: true, retryId: "retry_12345678",
    })
  })

  it("forwards the explicit attestation to the transactional recovery command", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.applicationTaskFindFirst.mockResolvedValueOnce({ id: "task_1", jobId: "job_1" })
    mocks.jobFindFirst.mockResolvedValueOnce({ url: "https://jobs.example/apply" })
    mocks.confirmSubmissionNotReceived.mockResolvedValueOnce({ inputId: "input_1", turnId: "turn_new", sequence: "8", disposition: "started" })
    const action = { type: "confirm_submission_not_received" as const, applicationTaskId: "task_1", requestId: "confirm_12345678", confirmedNotReceived: true as const }

    const response = await handleConfirmSubmissionNotReceivedAction("session_1", "user_1", action)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ inputId: "input_1", turnId: "turn_new", disposition: "started", recovered: true })
    expect(mocks.confirmSubmissionNotReceived).toHaveBeenCalledWith(expect.anything(), { ...action, sessionId: "session_1", userId: "user_1" })
    expect(mocks.assertActiveAccount).toHaveBeenCalledWith("user_1")
    expect(mocks.assertUnattendedApplyEnabled).toHaveBeenCalledWith("user_1")
    expect(mocks.validateAutoApplyUrl).toHaveBeenCalledWith("https://jobs.example/apply")
    expect(mocks.assertJobPreflight).toHaveBeenCalledWith({ userId: "user_1", jobId: "job_1" })
  })

  it("returns a conflict when the old submission cannot be proven safe to cancel", async () => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.applicationTaskFindFirst.mockResolvedValueOnce({ id: "task_1", jobId: "job_1" })
    mocks.jobFindFirst.mockResolvedValueOnce({ url: "https://jobs.example/apply" })
    mocks.confirmSubmissionNotReceived.mockRejectedValueOnce(Object.assign(new Error("The prior submit job or Redis lock is not safely terminal"), { status: 409 }))

    const response = await handleConfirmSubmissionNotReceivedAction("session_1", "user_1", {
      type: "confirm_submission_not_received", applicationTaskId: "task_1", requestId: "confirm_12345678", confirmedNotReceived: true,
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "The prior submit job or Redis lock is not safely terminal" })
  })

  it("keeps submission recovery unavailable when TaskGraph fill is disabled", async () => {
    const response = await handleConfirmSubmissionNotReceivedAction("session_1", "user_1", {
      type: "confirm_submission_not_received", applicationTaskId: "task_1", requestId: "confirm_12345678", confirmedNotReceived: true,
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "Submission recovery is unavailable while TaskGraph fill is disabled" })
    expect(mocks.confirmSubmissionNotReceived).not.toHaveBeenCalled()
  })

  it.each([
    ["active-account", () => mocks.assertActiveAccount.mockRejectedValueOnce(new Error("inactive"))],
    ["entitlement/runtime", () => mocks.assertUnattendedApplyEnabled.mockRejectedValueOnce(new Error("disabled"))],
    ["direct ATS URL", () => mocks.validateAutoApplyUrl.mockImplementationOnce(() => { throw new Error("unsupported URL") })],
    ["Job preflight", () => mocks.assertJobPreflight.mockRejectedValueOnce(new Error("job blocked"))],
  ] as const)("rejects recovery when %s preflight fails", async (_label, failPreflight) => {
    mocks.applicationFillTaskGraphEnabled.mockReturnValue(true)
    mocks.applicationTaskFindFirst.mockResolvedValueOnce({ id: "task_1", jobId: "job_1" })
    mocks.jobFindFirst.mockResolvedValueOnce({ url: "https://jobs.example/apply" })
    failPreflight()

    const response = await handleConfirmSubmissionNotReceivedAction("session_1", "user_1", {
      type: "confirm_submission_not_received", applicationTaskId: "task_1", requestId: "confirm_12345678", confirmedNotReceived: true,
    })

    expect(response.status).toBe(409)
    expect(mocks.confirmSubmissionNotReceived).not.toHaveBeenCalled()
  })
})
