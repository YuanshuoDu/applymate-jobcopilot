import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  taskUpsert: vi.fn(),
  taskUpdateMany: vi.fn(),
  taskFindUnique: vi.fn(),
  taskUpdate: vi.fn(),
  transaction: vi.fn(),
  eventCreate: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    applicationTask: { upsert: mocks.taskUpsert, updateMany: mocks.taskUpdateMany, findUnique: mocks.taskFindUnique, update: mocks.taskUpdate },
    applicationTaskEvent: { create: mocks.eventCreate },
    $transaction: mocks.transaction,
  },
}))

describe("application control plane", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.taskUpsert.mockReset().mockResolvedValue({ id: "task_1" })
    mocks.taskUpdateMany.mockReset().mockResolvedValue({ count: 1 })
    mocks.taskFindUnique.mockReset().mockResolvedValue({ id: "task_1", checkpoint: "materials_ready" })
    mocks.taskUpdate.mockReset().mockResolvedValue({ id: "task_1" })
    mocks.eventCreate.mockReset().mockResolvedValue({})
    mocks.transaction.mockReset().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      applicationTask: { upsert: mocks.taskUpsert, updateMany: mocks.taskUpdateMany, findUnique: mocks.taskFindUnique },
      applicationTaskEvent: { create: mocks.eventCreate },
    }))
  })

  it("creates a durable review checkpoint without queuing a submission", async () => {
    const { holdForApplicationReview } = await import("./application-control")
    await holdForApplicationReview({ userId: "user_1", jobId: "job_1", sessionId: "session_1", resumeId: "resume_1" })
    expect(mocks.taskUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ sessionId: "session_1", status: "waiting_for_user", checkpoint: "materials_ready" }),
      update: {},
    }))
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: "user_1",
      jobId: "job_1",
      sessionId: "session_1",
      OR: [
        {
          status: "generating_materials",
          OR: [
            { checkpoint: null },
            { checkpoint: { notIn: ["turn_stopped_before_submit", "submission_request_started", "submission_uncertain"] } },
          ],
        },
        { status: "waiting_for_user", checkpoint: "materials_ready" },
      ],
    } }))
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "materials_ready", actor: "reviewer" }),
    }))
  })

  it("requires a session before creating or refreshing the review checkpoint", async () => {
    const { holdForApplicationReview } = await import("./application-control")

    await expect(holdForApplicationReview({ userId: "user_1", jobId: "job_1" }))
      .rejects.toThrow("application_review_session_scope_required")

    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("moves same-session generating materials to the durable materials-ready checkpoint", async () => {
    mocks.taskFindUnique.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "materials_ready",
    })
    const { holdForApplicationReview } = await import("./application-control")

    await expect(holdForApplicationReview({ userId: "user_1", jobId: "job_1", sessionId: "session_1" }))
      .resolves.toMatchObject({ status: "waiting_for_user", checkpoint: "materials_ready" })

    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: "user_1",
        jobId: "job_1",
        sessionId: "session_1",
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: "generating_materials",
            OR: expect.arrayContaining([
              { checkpoint: null },
              { checkpoint: { notIn: ["turn_stopped_before_submit", "submission_request_started", "submission_uncertain"] } },
            ]),
          }),
        ]),
      }),
      data: expect.objectContaining({ status: "waiting_for_user", checkpoint: "materials_ready" }),
    }))
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "materials_ready", actor: "reviewer" }),
    }))
  })

  it("allows a same-session materials-ready retry", async () => {
    mocks.taskFindUnique.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "materials_ready",
    })
    const { holdForApplicationReview } = await import("./application-control")

    await expect(holdForApplicationReview({ userId: "user_1", jobId: "job_1", sessionId: "session_1" }))
      .resolves.toMatchObject({ status: "waiting_for_user", checkpoint: "materials_ready" })

    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sessionId: "session_1",
        OR: expect.arrayContaining([{ status: "waiting_for_user", checkpoint: "materials_ready" }]),
      }),
    }))
    expect(mocks.eventCreate).toHaveBeenCalledTimes(1)
  })

  it("does not reopen a same-session Stop-cancelled task", async () => {
    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 })
    mocks.taskFindUnique.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_1", status: "cancelled", checkpoint: "turn_stopped_before_submit",
    })
    const { holdForApplicationReview } = await import("./application-control")

    await expect(holdForApplicationReview({ userId: "user_1", jobId: "job_1", sessionId: "session_1" }))
      .resolves.toMatchObject({ status: "cancelled", checkpoint: "turn_stopped_before_submit" })

    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })

  it("does not refresh a task owned by another session", async () => {
    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 })
    mocks.taskFindUnique.mockResolvedValueOnce({
      id: "task_1", sessionId: "session_2", status: "generating_materials", checkpoint: "tailoring_and_cover_letter",
    })
    const { holdForApplicationReview } = await import("./application-control")

    await expect(holdForApplicationReview({ userId: "user_1", jobId: "job_1", sessionId: "session_1" }))
      .resolves.toMatchObject({ sessionId: "session_2", status: "generating_materials" })

    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1" }),
    }))
    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })

  it.each(["submission_request_started", "submission_uncertain"] as const)("preserves a concurrent %s checkpoint and does not emit a materials-ready event", async checkpoint => {
    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 })
    mocks.taskFindUnique.mockResolvedValueOnce({ id: "task_1", status: "filling", checkpoint })
    const { holdForApplicationReview } = await import("./application-control")

    await expect(holdForApplicationReview({ userId: "user_1", jobId: "job_1", sessionId: "session_1" }))
      .resolves.toMatchObject({ status: "filling", checkpoint })

    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      sessionId: "session_1",
      OR: [
        {
          status: "generating_materials",
          OR: [
            { checkpoint: null },
            { checkpoint: { notIn: ["turn_stopped_before_submit", "submission_request_started", "submission_uncertain"] } },
          ],
        },
        { status: "waiting_for_user", checkpoint: "materials_ready" },
      ],
    }) }))
    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })

  it("moves CAPTCHA, login and MFA cases to a user-takeover checkpoint", async () => {
    mocks.taskFindUnique.mockResolvedValueOnce({ id: "task_1", status: "waiting_for_user", checkpoint: "user_takeover" })
    const { requestUserTakeover } = await import("./application-control")
    await requestUserTakeover({ userId: "user_1", jobId: "job_1", reason: "captcha", detail: "CAPTCHA detected" })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId: "user_1",
        jobId: "job_1",
        OR: [{ checkpoint: null }, { checkpoint: { notIn: ["turn_stopped_before_submit", "submission_request_started", "submission_uncertain"] } }],
      },
      data: expect.objectContaining({ status: "waiting_for_user", checkpoint: "user_takeover" }),
    }))
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "user_takeover_required" }),
    }))
  })

  it.each(["turn_stopped_before_submit", "submission_request_started", "submission_uncertain"] as const)("preserves %s and emits no stale takeover event", async checkpoint => {
    mocks.taskUpdateMany.mockResolvedValueOnce({ count: 0 })
    const status = checkpoint === "turn_stopped_before_submit" ? "cancelled" : "filling"
    mocks.taskFindUnique.mockResolvedValueOnce({ id: "task_1", status, checkpoint })
    const { requestUserTakeover } = await import("./application-control")

    await expect(requestUserTakeover({ userId: "user_1", jobId: "job_1", reason: "captcha", detail: "CAPTCHA detected" }))
      .resolves.toMatchObject({ status, checkpoint })

    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ checkpoint: null }, { checkpoint: { notIn: ["turn_stopped_before_submit", "submission_request_started", "submission_uncertain"] } }],
      }),
    }))
    expect(mocks.eventCreate).not.toHaveBeenCalled()
  })
})
