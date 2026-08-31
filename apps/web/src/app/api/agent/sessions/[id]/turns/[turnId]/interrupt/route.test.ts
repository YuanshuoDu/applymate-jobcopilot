import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  class MockAgentCommandError extends Error {
    code: string
    status: number
    details: Record<string, unknown>

    constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
      super(message)
      this.code = code
      this.status = status
      this.details = details
    }
  }
  return { requireAuth: vi.fn(), interrupt: vi.fn(), MockAgentCommandError }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {} }))

vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandError: mocks.MockAgentCommandError,
  AgentCommandService: class {
    interrupt = mocks.interrupt
  },
}))

const params = { params: Promise.resolve({ id: "session_1", turnId: "turn_1" }) }

function request(body: unknown) {
  return new Request("http://localhost/api/agent/sessions/session_1/turns/turn_1/interrupt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("agent interrupt command API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.interrupt.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.interrupt.mockResolvedValue({ inputId: "input_1", turnId: "turn_1", disposition: "interrupted", sequence: "7" })
  })

  it("persists an interrupt independently of any SSE connection", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "interrupt_1" }) as never, params)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ inputId: "input_1", turnId: "turn_1", disposition: "interrupted", sequence: "7" })
    expect(mocks.interrupt).toHaveBeenCalledWith({
      sessionId: "session_1",
      userId: "user_1",
      clientMessageId: "interrupt_1",
      source: "user",
      expectedTurnId: "turn_1",
      expectedRevision: null,
    })
  })

  it("maps typed expected-turn conflicts without leaking internal details", async () => {
    mocks.interrupt.mockRejectedValueOnce(new mocks.MockAgentCommandError("active_turn_changed", "stale", 409, { expectedTurnId: "turn_1" }))
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "interrupt_stale" }) as never, params)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "active_turn_changed", details: { expectedTurnId: "turn_1" } } })
  })

  it("rejects client userId and tool commands before dispatch", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "interrupt_unsafe", userId: "other", tool: "submit_application" }) as never, params)

    expect(response.status).toBe(422)
    expect(mocks.interrupt).not.toHaveBeenCalled()
  })

  it("returns auth errors without dispatching an interrupt", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "interrupt_auth" }) as never, params)

    expect(response.status).toBe(401)
    expect(mocks.interrupt).not.toHaveBeenCalled()
  })
})
