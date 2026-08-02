import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  taskUpsert: vi.fn(),
  taskUpdate: vi.fn(),
  eventCreate: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    applicationTask: { upsert: mocks.taskUpsert, update: mocks.taskUpdate },
    applicationTaskEvent: { create: mocks.eventCreate },
  },
}))

describe("application control plane", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.taskUpsert.mockReset().mockResolvedValue({ id: "task_1" })
    mocks.taskUpdate.mockReset().mockResolvedValue({ id: "task_1" })
    mocks.eventCreate.mockReset().mockResolvedValue({})
  })

  it("creates a durable review checkpoint without queuing a submission", async () => {
    const { holdForApplicationReview } = await import("./application-control")
    await holdForApplicationReview({ userId: "user_1", jobId: "job_1", sessionId: "session_1", resumeId: "resume_1" })
    expect(mocks.taskUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "waiting_for_user", checkpoint: "materials_ready" }),
    }))
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "materials_ready", actor: "reviewer" }),
    }))
  })

  it("moves CAPTCHA, login and MFA cases to a user-takeover checkpoint", async () => {
    const { requestUserTakeover } = await import("./application-control")
    await requestUserTakeover({ userId: "user_1", jobId: "job_1", reason: "captcha", detail: "CAPTCHA detected" })
    expect(mocks.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "waiting_for_user", checkpoint: "user_takeover" }),
    }))
  })
})
