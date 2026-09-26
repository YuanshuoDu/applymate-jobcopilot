import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  approvalUpdateMany: vi.fn(),
  eventCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    applicationTask: { findFirst: mocks.findFirst, updateMany: mocks.updateMany },
    agentApproval: { updateMany: mocks.approvalUpdateMany },
    applicationTaskEvent: { create: mocks.eventCreate },
    $transaction: mocks.transaction,
  },
}))

describe("DELETE /api/agent/application-tasks", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.findFirst.mockResolvedValue({ id: "task_1", sessionId: "session_1", status: "waiting_for_authorization", checkpoint: "form_filled" })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.approvalUpdateMany.mockResolvedValue({ count: 1 })
    mocks.eventCreate.mockResolvedValue({ id: "event_1" })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      applicationTask: { updateMany: mocks.updateMany },
      applicationTaskEvent: { create: mocks.eventCreate },
      agentApproval: { updateMany: mocks.approvalUpdateMany },
    }))
  })

  it("revokes a pending final-submission authorization with the cancelled task", async () => {
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ cancelled: true })
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "task_1",
        userId: "user_1",
        status: { notIn: ["submitted", "skipped", "cancelled"] },
        OR: [{ checkpoint: null }, { checkpoint: { notIn: ["submission_request_started", "submission_uncertain"] } }],
      }),
      data: expect.objectContaining({ status: "cancelled", checkpoint: "cancelled_by_user" }),
    }))
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        sessionId: "session_1",
        userId: "user_1",
        type: "submit_application",
        status: "pending",
        payload: { path: ["applicationTaskId"], equals: "task_1" },
      }),
      data: expect.objectContaining({ status: "cancelled" }),
    }))
  })

  it("does not mutate an already screened-out task", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "skipped", checkpoint: "screened_out" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("conflicts if the worker marks submission started after the user's initial read", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "browser_active" })
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.updateMany).toHaveBeenCalledOnce()
    expect(mocks.eventCreate).not.toHaveBeenCalled()
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled()
  })

  it("rejects a task already at the submission-start checkpoint", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "filling", checkpoint: "submission_request_started" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("rejects an application with an uncertain submission outcome", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "task_1", sessionId: "session_1", status: "waiting_for_user", checkpoint: "submission_uncertain" })
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
