import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentExecution: { findFirst: mocks.findFirst },
    agentSession: { updateMany: mocks.updateMany },
  },
}))

vi.mock("@/lib/agent/execution-control", () => ({ cancelAgentExecution: mocks.cancel }))

describe("DELETE /api/agent/executions", () => {
  beforeEach(() => {
    mocks.requireAuth.mockReset()
    mocks.findFirst.mockReset()
    mocks.updateMany.mockReset()
    mocks.cancel.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.cancel.mockResolvedValue(true)
  })

  it("cancels the active execution selected by its session", async () => {
    mocks.findFirst.mockResolvedValue({ id: "execution_1" })
    const { DELETE } = await import("./route")

    const response = await DELETE(new Request("http://localhost/api/agent/executions?sessionId=session_1", { method: "DELETE" }) as never)

    expect(response.status).toBe(200)
    expect(mocks.cancel).toHaveBeenCalledWith({ id: "execution_1", userId: "user_1" })
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1", userId: "user_1" }),
    }))
  })

  it("does not cancel a completed session when no active execution exists", async () => {
    mocks.findFirst.mockResolvedValue(null)
    const { DELETE } = await import("./route")

    const response = await DELETE(new Request("http://localhost/api/agent/executions?sessionId=session_1", { method: "DELETE" }) as never)

    expect(response.status).toBe(404)
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
})
