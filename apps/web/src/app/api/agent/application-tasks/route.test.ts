import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
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
    applicationTask: { findFirst: mocks.findFirst, update: mocks.update },
    agentApproval: { updateMany: mocks.approvalUpdateMany },
    applicationTaskEvent: { create: mocks.eventCreate },
    $transaction: mocks.transaction,
  },
}))

describe("DELETE /api/agent/application-tasks", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.findFirst.mockResolvedValue({ id: "task_1", sessionId: "session_1", status: "waiting_for_authorization" })
    mocks.update.mockResolvedValue({ id: "task_1" })
    mocks.approvalUpdateMany.mockResolvedValue({ count: 1 })
    mocks.eventCreate.mockResolvedValue({ id: "event_1" })
    mocks.transaction.mockImplementation((operations: Array<Promise<unknown>>) => Promise.all(operations))
  })

  it("revokes a pending final-submission authorization with the cancelled task", async () => {
    const { DELETE } = await import("./route")
    const request = new Request("http://localhost/api/agent/application-tasks?id=task_1", { method: "DELETE" })

    const response = await DELETE(request as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ cancelled: true })
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
})
