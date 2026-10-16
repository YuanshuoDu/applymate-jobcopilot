import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api-helpers", () => ({
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
}))

const mocks = vi.hoisted(() => ({
  applicationFillTaskGraphEnabled: vi.fn(),
  applicationTaskFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  queueApplicationFill: vi.fn(),
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

import { handleRetryApplicationFillAction } from "./handlers"

describe("session action handlers", () => {
  beforeEach(() => {
    mocks.applicationFillTaskGraphEnabled.mockReset().mockReturnValue(false)
    mocks.applicationTaskFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.queueApplicationFill.mockReset()
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
})
