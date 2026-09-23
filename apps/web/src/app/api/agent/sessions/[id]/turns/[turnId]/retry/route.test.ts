import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), retry: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandService: class { retry = mocks.retry },
  AgentCommandError: class extends Error {
    readonly code: string
    readonly status: number
    readonly details: Record<string, unknown>
    constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
      super(message)
      this.code = code
      this.status = status
      this.details = details
    }
  },
}))

const params = { params: Promise.resolve({ id: "session_1", turnId: "turn_failed" }) }

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("http://localhost/api/agent/sessions/session_1/turns/turn_failed/retry", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })
}

describe("agent retry command API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.retry.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.retry.mockResolvedValue({ inputId: "input_1", turnId: "turn_new", disposition: "started", sequence: "8" })
  })

  it("accepts a URL-scoped retry and returns the queued root result", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "retry_1", expectedRevision: 4 }) as never, params)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ inputId: "input_1", turnId: "turn_new", disposition: "started", sequence: "8" })
    expect(mocks.retry).toHaveBeenCalledWith({
      sessionId: "session_1", userId: "user_1", clientMessageId: "retry_1", source: "user", targetTurnId: "turn_failed", expectedRevision: 4,
    })
  })

  it("returns 200 for an idempotent duplicate and never accepts client scope", async () => {
    mocks.retry.mockResolvedValueOnce({ inputId: "input_1", turnId: "turn_new", disposition: "duplicate", originalDisposition: "started", sequence: "8" })
    const { POST } = await import("./route")
    const response = await POST(request({ expectedRevision: null }, { "idempotency-key": "retry_1" }) as never, params)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ disposition: "duplicate" })

    const forbidden = await POST(request({ clientMessageId: "retry_2", userId: "other", tool: "submit_application" }) as never, params)
    expect(forbidden.status).toBe(422)
    expect(mocks.retry).toHaveBeenCalledTimes(1)
  })

  it("maps typed active conflicts and auth failures without dispatching", async () => {
    const { POST } = await import("./route")
    mocks.retry.mockRejectedValueOnce(new (await import("@/lib/agent/control-plane/commands")).AgentCommandError("retry_active_conflict", "active", 409, { turnId: "turn_active" }))
    const conflict = await POST(request({ clientMessageId: "retry_conflict" }) as never, params)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "retry_active_conflict", details: { turnId: "turn_active" } } })

    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const unauthorized = await POST(request({ clientMessageId: "retry_auth" }) as never, params)
    expect(unauthorized.status).toBe(401)
    expect(mocks.retry).toHaveBeenCalledTimes(1)
  })
})
