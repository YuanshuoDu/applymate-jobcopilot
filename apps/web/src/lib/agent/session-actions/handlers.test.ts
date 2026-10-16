import { beforeEach, describe, expect, it, vi } from "vitest"

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
  queueApplicationFill: vi.fn(),
  confirmSubmissionNotReceived: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    applicationTask: { findFirst: mocks.applicationTaskFindFirst },
    job: { findFirst: mocks.jobFindFirst },
  },
}))

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

import { handleConfirmSubmissionNotReceivedAction, handleRetryApplicationFillAction } from "./handlers"

describe("session action handlers", () => {
  beforeEach(() => {
    mocks.applicationFillTaskGraphEnabled.mockReset().mockReturnValue(false)
    mocks.assertActiveAccount.mockReset().mockResolvedValue(undefined)
    mocks.assertUnattendedApplyEnabled.mockReset().mockResolvedValue(undefined)
    mocks.validateAutoApplyUrl.mockReset().mockReturnValue("https://jobs.example/apply")
    mocks.assertJobPreflight.mockReset().mockResolvedValue(undefined)
    mocks.applicationTaskFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.queueApplicationFill.mockReset()
    mocks.confirmSubmissionNotReceived.mockReset()
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
