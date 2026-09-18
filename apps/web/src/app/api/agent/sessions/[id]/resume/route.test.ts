import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), resume: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandService: class { resume = mocks.resume },
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
  return new Request("http://localhost/api/agent/sessions/session_1/resume", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })
}

describe("agent resume command API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.resume.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.resume.mockResolvedValue({ sessionId: "session_1", operation: "resume", controlGate: "open", controlRevision: 2, pausedAt: null, disposition: "applied" })
  })

  it("accepts a header idempotency key and keeps auth scope server-owned", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ expectedRevision: 1 }, { "idempotency-key": "resume_1" }) as never, params)
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ operation: "resume", controlGate: "open" })
    expect(mocks.resume).toHaveBeenCalledWith({ sessionId: "session_1", userId: "user_1", clientMessageId: "resume_1", source: "user", expectedRevision: 1 })
  })

  it("returns 200 for an open-session noop", async () => {
    mocks.resume.mockResolvedValueOnce({ sessionId: "session_1", operation: "resume", controlGate: "open", controlRevision: 0, pausedAt: null, disposition: "noop" })
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "resume_2" }) as never, params)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ disposition: "noop", controlRevision: 0 })
  })

  it("maps stale revisions and rejects unknown fields", async () => {
    const { POST } = await import("./route")
    const forbidden = await POST(request({ clientMessageId: "resume_3", expectedRevision: 1, userId: "other" }) as never, params)
    expect(forbidden.status).toBe(422)
    mocks.resume.mockRejectedValueOnce(new (await import("@/lib/agent/control-plane/commands")).AgentCommandError("session_control_revision_changed", "stale", 409, { expectedRevision: 1, actualRevision: 2 }))
    const stale = await POST(request({ clientMessageId: "resume_4", expectedRevision: 1 }) as never, params)
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "session_control_revision_changed" } })
  })
})
