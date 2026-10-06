import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  class MockAgentCommandError extends Error {
    constructor(readonly code: string, message: string, readonly status: number, readonly details: Record<string, unknown> = {}) { super(message) }
  }
  return { auth: vi.fn(), control: vi.fn(), MockAgentCommandError }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.auth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands", () => ({ AgentCommandError: mocks.MockAgentCommandError, AgentSessionControlService: class { control = mocks.control } }))

const context = { params: Promise.resolve({ id: "session_1" }) }
function request(body: unknown) {
  return new Request("http://localhost/api/agent/sessions/session_1/control", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}

describe("agent session control API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.auth.mockReset(); mocks.control.mockReset()
    mocks.auth.mockResolvedValue({ userId: "user_1" })
    mocks.control.mockResolvedValue({ sessionId: "session_1", turnId: "turn_1", action: "pause", status: "pausing", disposition: "requested", sequence: "7" })
  })

  it("accepts a pause command and binds ownership to authenticated user plus URL session", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "control_1", action: "pause", expectedTurnId: "turn_1", expectedRevision: 3 }) as never, context)
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ action: "pause", status: "pausing", disposition: "requested" })
    expect(mocks.control).toHaveBeenCalledWith({
      sessionId: "session_1", userId: "user_1", clientMessageId: "control_1", action: "pause", expectedTurnId: "turn_1", expectedRevision: 3,
    })
  })

  it("returns 200 for an idempotent replay and maps stale Turn errors", async () => {
    mocks.control.mockResolvedValueOnce({ sessionId: "session_1", turnId: "turn_1", action: "resume", status: "resuming", disposition: "duplicate", sequence: "8" })
    const { POST } = await import("./route")
    const duplicate = await POST(request({ clientMessageId: "control_2", action: "resume", expectedTurnId: "turn_1", expectedRevision: 3 }) as never, context)
    expect(duplicate.status).toBe(200)
    mocks.control.mockRejectedValueOnce(new mocks.MockAgentCommandError("active_turn_changed", "stale", 409, { expectedTurnId: "turn_1" }))
    const stale = await POST(request({ clientMessageId: "control_3", action: "pause", expectedTurnId: "turn_1", expectedRevision: 3 }) as never, context)
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "active_turn_changed" } })
  })

  it("does not dispatch unauthenticated or invalid commands", async () => {
    mocks.auth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { POST } = await import("./route")
    const unauthenticated = await POST(request({ clientMessageId: "no", action: "pause", expectedTurnId: "turn_1", expectedRevision: 3 }) as never, context)
    expect(unauthenticated.status).toBe(401)
    const invalid = await POST(request({ clientMessageId: "bad", action: "pause", expectedTurnId: "turn_1", expectedRevision: 3, userId: "other" }) as never, context)
    expect(invalid.status).toBe(422)
    expect(mocks.control).not.toHaveBeenCalled()
  })
})
