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
  return { requireAuth: vi.fn(), fork: vi.fn(), MockAgentCommandError }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {} }))

vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandError: mocks.MockAgentCommandError,
  AgentForkService: class { fork = mocks.fork },
}))

const params = { params: Promise.resolve({ id: "session_1" }) }

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("http://localhost/api/agent/sessions/session_1/fork", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })
}

describe("agent session fork API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.fork.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.fork.mockResolvedValue({ sessionId: "fork_1", turnId: "turn_1", lastTurnId: "turn_0", disposition: "forked" })
  })

  it("passes authenticated scope, boundary and edit content to the control plane", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "fork_1", lastTurnId: "turn_0", editContent: [{ type: "text", text: "Use Dublin" }] }) as never, params)

    expect(response.status).toBe(201)
    expect(mocks.fork).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session_1", userId: "user_1", source: "user", lastTurnId: "turn_0" }))
    expect(mocks.fork.mock.calls[0][0].editContent).toEqual([{ type: "text", text: "Use Dublin" }])
  })

  it("returns 200 for an idempotent duplicate and rejects forbidden fields", async () => {
    mocks.fork.mockResolvedValueOnce({ sessionId: "fork_1", turnId: "turn_1", lastTurnId: "turn_0", disposition: "duplicate" })
    const { POST } = await import("./route")
    const duplicate = await POST(request({ clientMessageId: "fork_1", lastTurnId: "turn_0" }) as never, params)
    expect(duplicate.status).toBe(200)

    const forbidden = await POST(request({ clientMessageId: "fork_2", lastTurnId: "turn_0", sessionId: "other" }) as never, params)
    expect(forbidden.status).toBe(422)
    expect(mocks.fork).toHaveBeenCalledTimes(1)
  })
})
