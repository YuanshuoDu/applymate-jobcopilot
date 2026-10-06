import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), interrupt: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands/task-interrupt-service", () => ({
  TaskInterruptError: class TaskInterruptError extends Error {
    constructor(readonly code: string, readonly status: number, message: string) { super(message) }
  },
  TaskInterruptService: class { interrupt = mocks.interrupt },
}))

const context = { params: Promise.resolve({ id: "session-1", taskId: "task-1" }) }
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/agent/sessions/session-1/tasks/task-1/interrupt", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })
}

describe("child task interrupt route", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "user-1" })
    mocks.interrupt.mockReset().mockResolvedValue({ intentId: "intent-1", taskId: "task-1", turnId: "turn-1", disposition: "accepted", sequence: "9" })
  })

  it("authenticates and accepts only a replay key, without a client lineage", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "retry-1" }) as never, context)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ disposition: "accepted", taskId: "task-1", sequence: "9" })
    expect(mocks.interrupt).toHaveBeenCalledWith({ sessionId: "session-1", taskId: "task-1", userId: "user-1", clientMessageId: "retry-1" })
  }, 15_000)

  it("accepts the idempotency header and rejects client-supplied ownership or ancestry", async () => {
    const { POST } = await import("./route")
    const valid = await POST(request({}, { "idempotency-key": "header-1" }) as never, context)
    expect(valid.status).toBe(202)
    expect(mocks.interrupt).toHaveBeenLastCalledWith({ sessionId: "session-1", taskId: "task-1", userId: "user-1", clientMessageId: "header-1" })

    const invalid = await POST(request({ clientMessageId: "unsafe", userId: "other", rootTaskId: "root", path: "/root/task" }) as never, context)
    expect(invalid.status).toBe(422)
    expect(mocks.interrupt).toHaveBeenCalledTimes(1)
  })

  it("returns stable typed conflicts and stops before service dispatch when unauthenticated", async () => {
    const { TaskInterruptError } = await import("@/lib/agent/control-plane/commands/task-interrupt-service")
    mocks.interrupt.mockRejectedValueOnce(new TaskInterruptError("task_interrupt_target_unavailable", 409, "stale"))
    const { POST } = await import("./route")
    const conflict = await POST(request({ clientMessageId: "retry-1" }) as never, context)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "task_interrupt_target_unavailable", details: {} } })

    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const unauthorized = await POST(request({ clientMessageId: "retry-2" }) as never, context)
    expect(unauthorized.status).toBe(401)
    expect(mocks.interrupt).toHaveBeenCalledTimes(1)
  })
})
