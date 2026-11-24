import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), sessionFindFirst: vi.fn(), start: vi.fn(), taskGraphEnabled: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock("@/lib/db", () => ({ db: { agentSession: { findFirst: mocks.sessionFindFirst } } }))
vi.mock("@/lib/auto-apply", () => ({ applicationFillTaskGraphEnabled: mocks.taskGraphEnabled }))
vi.mock("@/lib/agent/control-plane/commands/reviewed-application-review", () => ({
  ReviewedApplicationReviewCommandService: class { start = mocks.start },
}))
vi.mock("../../command-route-helpers", () => ({
  commandErrorResponse: () => Response.json({ error: "command failed" }, { status: 409 }),
}))

const context = { params: Promise.resolve({ id: "session_1" }) }
function request(body: unknown) {
  return new Request("http://localhost/api/agent/sessions/session_1/reviewed-application-review", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}

describe("reviewed application review request API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockReset().mockResolvedValue({ id: "session_1" })
    mocks.start.mockReset().mockResolvedValue({ inputId: "input_1", turnId: "turn_new", disposition: "started", sequence: "4" })
    mocks.taskGraphEnabled.mockReset().mockReturnValue(true)
  })

  it("starts only the authenticated user's bounded source-Turn command and returns safe fields", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ sourceTurnId: "turn_source", idempotencyKey: "review-request-1" }) as never, context)

    expect(response.status).toBe(202)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(response.json()).resolves.toEqual({ turnId: "turn_new", disposition: "started" })
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
    expect(mocks.start).toHaveBeenCalledWith({
      sessionId: "session_1", userId: "user_1", clientMessageId: "review-request-1", sourceTurnId: "turn_source",
    })
  })

  it("accepts an idempotent duplicate without returning command internals", async () => {
    mocks.start.mockResolvedValueOnce({ inputId: "private", turnId: "turn_existing", disposition: "duplicate", sequence: "5" })
    const { POST } = await import("./route")
    const response = await POST(request({ sourceTurnId: "turn_source", idempotencyKey: "review-request-1" }) as never, context)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ turnId: "turn_existing", disposition: "duplicate" })
  })

  it("rejects extra, malformed, or oversized body data before starting a command", async () => {
    const { POST } = await import("./route")
    for (const body of [
      { sourceTurnId: "turn_source", idempotencyKey: "k", userId: "attacker" },
      { sourceTurnId: " turn_source", idempotencyKey: "k" },
      { sourceTurnId: "turn_source", idempotencyKey: "has space" },
      { sourceTurnId: "turn_source", idempotencyKey: "x".repeat(129) },
    ]) expect((await POST(request(body) as never, context)).status).toBe(422)
    expect((await POST(request({ sourceTurnId: "x".repeat(1100), idempotencyKey: "k" }) as never, context)).status).toBe(422)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("fails closed for unauthenticated, disabled, or non-owned sessions", async () => {
    const { POST } = await import("./route")
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }))
    expect((await POST(request({ sourceTurnId: "turn_source", idempotencyKey: "k" }) as never, context)).status).toBe(401)
    mocks.taskGraphEnabled.mockReturnValue(false)
    expect((await POST(request({ sourceTurnId: "turn_source", idempotencyKey: "k" }) as never, context)).status).toBe(409)
    mocks.taskGraphEnabled.mockReturnValue(true)
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    expect((await POST(request({ sourceTurnId: "turn_source", idempotencyKey: "k" }) as never, context)).status).toBe(404)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("maps command conflicts without starting browser or submission work", async () => {
    mocks.start.mockRejectedValueOnce(new Error("active command"))
    const { POST } = await import("./route")
    expect((await POST(request({ sourceTurnId: "turn_source", idempotencyKey: "k" }) as never, context)).status).toBe(409)
    expect(mocks.start).toHaveBeenCalledOnce()
  })
})
