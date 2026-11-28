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
  jobUpdateMany: vi.fn(),
  resumeFindFirst: vi.fn(),
  txQueryRaw: vi.fn(),
  transaction: vi.fn(),
  eventCreate: vi.fn(),
  updateAgentSession: vi.fn(),
  approvalFindFirst: vi.fn(),
  queueApplicationFill: vi.fn(),
  confirmSubmissionNotReceived: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    applicationTask: { findFirst: mocks.applicationTaskFindFirst },
    job: { findFirst: mocks.jobFindFirst, updateMany: mocks.jobUpdateMany },
    resume: { findFirst: mocks.resumeFindFirst },
    agentApproval: { findFirst: mocks.approvalFindFirst },
    agentTranscriptEvent: { create: mocks.eventCreate },
    $transaction: mocks.transaction,
  },
}))
vi.mock("../session/repository", () => ({ updateAgentSession: mocks.updateAgentSession }))

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

import { handleConfirmSubmissionNotReceivedAction, handleRetryApplicationFillAction, handleConfirmedTailoredResume, validateReceiptForApproval } from "./handlers"

describe("session action handlers", () => {
  beforeEach(() => {
    mocks.applicationFillTaskGraphEnabled.mockReset().mockReturnValue(false)
    mocks.assertActiveAccount.mockReset().mockResolvedValue(undefined)
    mocks.assertUnattendedApplyEnabled.mockReset().mockResolvedValue(undefined)
    mocks.validateAutoApplyUrl.mockReset().mockReturnValue("https://jobs.example/apply")
    mocks.assertJobPreflight.mockReset().mockResolvedValue(undefined)
    mocks.applicationTaskFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.jobUpdateMany.mockReset()
    mocks.resumeFindFirst.mockReset()
    mocks.txQueryRaw.mockReset()
    mocks.transaction.mockReset()
    mocks.eventCreate.mockReset()
    mocks.updateAgentSession.mockReset()
    mocks.queueApplicationFill.mockReset()
    mocks.confirmSubmissionNotReceived.mockReset()
    mocks.approvalFindFirst.mockReset()
  })

  it("fences tailored-resume Job status writes before the row lock and applies an exact CAS", async () => {
    const order: string[] = []
    let queryCount = 0
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: mocks.txQueryRaw,
      resume: { findFirst: mocks.resumeFindFirst },
      job: { findFirst: mocks.jobFindFirst, updateMany: mocks.jobUpdateMany },
    }))
    mocks.txQueryRaw.mockImplementation(async () => {
      queryCount += 1
      order.push(queryCount === 1 ? "source-lock" : queryCount === 2 ? "source-verify" : "job-row-lock")
      return queryCount < 3 ? [{ transaction_id: "31", lock_acquired: "" }] : [{ id: "job_1" }]
    })
    mocks.resumeFindFirst.mockImplementation(async () => { order.push("resume-read"); return { id: "resume_1", name: "Tailored" } })
    mocks.jobFindFirst.mockImplementation(async () => { order.push("job-read"); return {
      id: "job_1", company: "Acme", role: "Engineer", url: "https://jobs.example/1", status: "discovered",
      workflowState: "draft", finalResumeId: null,
    } })
    mocks.jobUpdateMany.mockImplementation(async () => { order.push("job-cas"); return { count: 1 } })
    mocks.eventCreate.mockResolvedValue({ id: "event_1", sessionId: "session_1", taskId: null, type: "resume_finalized",
      speaker: "Reviewer", title: "Application pack ready", durationMs: null, createdAt: new Date() })

    const response = await handleConfirmedTailoredResume("session_1", "user_1", {
      id: "approval_1", payload: { resumeId: "resume_1", jobId: "job_1" },
    } as Parameters<typeof handleConfirmedTailoredResume>[2])

    expect(response.status).toBe(200)
    expect(order).toEqual(["source-lock", "source-verify", "resume-read", "job-row-lock", "job-read", "job-cas"])
    expect(mocks.txQueryRaw).toHaveBeenCalledTimes(3)
    const rowLock = mocks.txQueryRaw.mock.calls[2]?.[0] as { sql?: string }
    expect(rowLock.sql).toContain('FROM "Job"')
    expect(rowLock.sql).toContain('"userId" =')
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job_1", userId: "user_1", status: "discovered", workflowState: "draft", finalResumeId: null },
      data: expect.objectContaining({ finalResumeId: "resume_1", status: "saved", workflowState: "ready_to_apply" }),
    })
    expect(mocks.updateAgentSession).toHaveBeenCalledOnce()
  })

  it("does not overwrite a Job that became applied before the locked read", async () => {
    let queryCount = 0
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: mocks.txQueryRaw,
      resume: { findFirst: mocks.resumeFindFirst },
      job: { findFirst: mocks.jobFindFirst, updateMany: mocks.jobUpdateMany },
    }))
    mocks.txQueryRaw.mockImplementation(async () => {
      queryCount += 1
      return queryCount < 3 ? [{ transaction_id: "32", lock_acquired: "" }] : [{ id: "job_1" }]
    })
    mocks.resumeFindFirst.mockResolvedValue({ id: "resume_1", name: "Tailored" })
    mocks.jobFindFirst.mockResolvedValue({ id: "job_1", company: "Acme", role: "Engineer", url: null,
      status: "applied", workflowState: "submitted", finalResumeId: "resume_old" })

    const response = await handleConfirmedTailoredResume("session_1", "user_1", {
      id: "approval_1", payload: { resumeId: "resume_1", jobId: "job_1" },
    } as Parameters<typeof handleConfirmedTailoredResume>[2])

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "This job has already been submitted." })
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.updateAgentSession).not.toHaveBeenCalled()
  })

  it("reports a CAS miss without emitting a finalized event", async () => {
    let queryCount = 0
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: mocks.txQueryRaw,
      resume: { findFirst: mocks.resumeFindFirst },
      job: { findFirst: mocks.jobFindFirst, updateMany: mocks.jobUpdateMany },
    }))
    mocks.txQueryRaw.mockImplementation(async () => {
      queryCount += 1
      return queryCount < 3 ? [{ transaction_id: "33", lock_acquired: "" }] : [{ id: "job_1" }]
    })
    mocks.resumeFindFirst.mockResolvedValue({ id: "resume_1", name: "Tailored" })
    mocks.jobFindFirst.mockResolvedValue({ id: "job_1", company: "Acme", role: "Engineer", url: null,
      status: "discovered", workflowState: "draft", finalResumeId: null })
    mocks.jobUpdateMany.mockResolvedValue({ count: 0 })

    const response = await handleConfirmedTailoredResume("session_1", "user_1", {
      id: "approval_1", payload: { resumeId: "resume_1", jobId: "job_1" },
    } as Parameters<typeof handleConfirmedTailoredResume>[2])

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "The job changed while confirming the final resume." })
    expect(mocks.jobUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.updateAgentSession).not.toHaveBeenCalled()
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
