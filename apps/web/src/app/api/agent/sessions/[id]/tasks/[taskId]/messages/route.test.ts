import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), send: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands/task-message-service", () => ({
  TaskMessageError: class TaskMessageError extends Error {
    constructor(readonly code: string, readonly status: number, message: string) { super(message) }
  },
  TaskMessageService: class { send = mocks.send },
}))

const context = { params: Promise.resolve({ id: "session-1", taskId: "task-1" }) }
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/agent/sessions/session-1/tasks/task-1/messages", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })
}

describe("child task follow-up route", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "user-1" })
    mocks.send.mockReset().mockResolvedValue({
      messageId: "message-1", itemId: "item-1", taskId: "task-1", turnId: "turn-1",
      targetAttemptCount: 3, disposition: "accepted", sequence: "9",
    })
  })

  it("authenticates and sends the message bound to the route task", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "client-1", text: "Please check the result", expectedAttemptCount: 3 }) as never, context)
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ disposition: "accepted", taskId: "task-1", targetAttemptCount: 3 })
    expect(mocks.send).toHaveBeenCalledWith({ sessionId: "session-1", taskId: "task-1", userId: "user-1",
      clientMessageId: "client-1", text: "Please check the result", expectedAttemptCount: 3 })
  }, 15_000)

  it("rejects unsupported fields, invalid attempts, and mismatched idempotency headers before dispatch", async () => {
    const { POST } = await import("./route")
    const invalidBodies = [
      { clientMessageId: "client-1", text: "hello", userId: "other" },
      { clientMessageId: "client-1", text: "hello", expectedAttemptCount: 0 },
      { clientMessageId: "client-1", text: "   " },
    ]
    for (const body of invalidBodies) {
      expect((await POST(request(body) as never, context)).status).toBe(422)
    }
    const mismatch = await POST(request({ clientMessageId: "body-key", text: "hello" }, { "idempotency-key": "other-key" }) as never, context)
    expect(mismatch.status).toBe(422)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("returns service conflicts and does not dispatch when authentication fails", async () => {
    const { TaskMessageError } = await import("@/lib/agent/control-plane/commands/task-message-service")
    mocks.send.mockRejectedValueOnce(new TaskMessageError("task_follow_up_attempt_changed", 409, "attempt changed"))
    const { POST } = await import("./route")
    const conflict = await POST(request({ clientMessageId: "client-1", text: "hello" }) as never, context)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "task_follow_up_attempt_changed", details: {} } })

    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const unauthorized = await POST(request({ clientMessageId: "client-2", text: "hello" }) as never, context)
    expect(unauthorized.status).toBe(401)
    expect(mocks.send).toHaveBeenCalledOnce()
  })
})
