import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), pause: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandService: class { pause = mocks.pause },
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

const params = { params: Promise.resolve({ id: "session_1" }) }

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("http://localhost/api/agent/sessions/session_1/pause", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })
}

describe("agent pause command API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.pause.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.pause.mockResolvedValue({ sessionId: "session_1", operation: "pause", controlGate: "user_paused", controlRevision: 1, pausedAt: "2026-09-15T12:00:00.000Z", disposition: "applied" })
  })

  it("accepts an authenticated URL-scoped pause", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "pause_1", expectedRevision: 0 }) as never, params)
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ operation: "pause", controlGate: "user_paused", disposition: "applied" })
    expect(mocks.pause).toHaveBeenCalledWith({ sessionId: "session_1", userId: "user_1", clientMessageId: "pause_1", source: "user", expectedRevision: 0 })
  })

  it("returns 200 for noop or duplicate and maps typed conflicts", async () => {
    const { POST } = await import("./route")
    mocks.pause.mockResolvedValueOnce({ sessionId: "session_1", operation: "pause", controlGate: "user_paused", controlRevision: 1, pausedAt: null, disposition: "duplicate" })
    const duplicate = await POST(request({ clientMessageId: "pause_2" }) as never, params)
    expect(duplicate.status).toBe(200)
    mocks.pause.mockRejectedValueOnce(new (await import("@/lib/agent/control-plane/commands")).AgentCommandError("session_pause_conflict", "active", 409, { turnId: "turn_1" }))
    const conflict = await POST(request({ clientMessageId: "pause_3" }) as never, params)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "session_pause_conflict" } })
  })

  it("returns auth and parser failures without dispatching", async () => {
    const { POST } = await import("./route")
    const forbidden = await POST(request({ clientMessageId: "pause_4", tool: "resume" }) as never, params)
    expect(forbidden.status).toBe(422)
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const unauthorized = await POST(request({ clientMessageId: "pause_5" }) as never, params)
    expect(unauthorized.status).toBe(401)
    expect(mocks.pause).toHaveBeenCalledTimes(0)
  })
})
