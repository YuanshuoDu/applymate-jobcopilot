import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), sessionFindFirst: vi.fn(), start: vi.fn(), tenantContext: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock("@/lib/db", () => ({ db: { agentSession: { findFirst: mocks.sessionFindFirst } } }))
vi.mock("@/lib/db/tenant-store", () => ({
  runWithTenantContext: mocks.tenantContext,
}))
vi.mock("@/lib/agent/control-plane/commands/objective-application-review", () => ({
  ObjectiveApplicationReviewCommandService: class { start = mocks.start },
}))
vi.mock("../../command-route-helpers", () => ({
  commandErrorResponse: () => Response.json({ error: "command failed" }, { status: 409 }),
}))

const context = { params: Promise.resolve({ id: "session_1" }) }
const selection = {
  schema: "agent-harness.v2.objective-application-review-intent.v1",
  sourceTurnId: "source_turn_1", rootTaskId: "root_1", graphItemId: "graph_1", graphRevision: 7, slotOrdinals: [2],
}
function request(body: unknown, contentType: string | null = "application/json") {
  return new Request("http://localhost/api/agent/sessions/session_1/objective-application-review", {
    method: "POST", headers: contentType ? { "content-type": contentType } : {}, body: JSON.stringify(body),
  })
}

describe("objective application review route", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockReset().mockResolvedValue({ id: "session_1" })
    mocks.start.mockReset().mockResolvedValue({ inputId: "private", turnId: "turn_new", disposition: "started", sequence: "4" })
    mocks.tenantContext.mockReset().mockImplementation(async (_userId: string, callback: () => Promise<unknown>) => callback())
  })

  it("starts only an authenticated owner's exact source selection and returns a bounded result", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ idempotencyKey: "objective-review-1", selection }) as never, context)

    expect(response.status).toBe(202)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(response.json()).resolves.toEqual({ turnId: "turn_new", disposition: "started" })
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" }, select: { id: true },
    })
    expect(mocks.tenantContext).toHaveBeenCalledWith("user_1", expect.any(Function))
    expect(mocks.start).toHaveBeenCalledWith({
      sessionId: "session_1", userId: "user_1", clientMessageId: "objective-review-1", selection,
    })
  })

  it("replays safely without returning command internals", async () => {
    mocks.start.mockResolvedValueOnce({ inputId: "secret", turnId: "turn_existing", disposition: "duplicate", sequence: "8" })
    const { POST } = await import("./route")
    const response = await POST(request({ idempotencyKey: "objective-review-1", selection }) as never, context)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ turnId: "turn_existing", disposition: "duplicate" })
  })

  it("rejects extra client authority, invalid selections, and oversized bodies before the command", async () => {
    const { POST } = await import("./route")
    expect((await POST(request({ idempotencyKey: "k", selection }, null) as never, context)).status).toBe(422)
    expect((await POST(request({ idempotencyKey: "k", selection }, "text/plain") as never, context)).status).toBe(422)
    for (const body of [
      { idempotencyKey: "k", selection, userId: "attacker" },
      { idempotencyKey: "k", selection, jobId: "job_1" },
      { idempotencyKey: "has space", selection },
      { idempotencyKey: "k", selection: { ...selection, graphRevision: 0 } },
      { idempotencyKey: "k", selection: { ...selection, slotOrdinals: [2, 2] } },
    ]) expect((await POST(request(body) as never, context)).status).toBe(422)
    expect((await POST(request({ idempotencyKey: "k", selection: { ...selection, sourceTurnId: "x".repeat(5000) } }) as never, context)).status).toBe(422)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.tenantContext).not.toHaveBeenCalled()
  })

  it("fails closed for unauthenticated and non-owned sessions", async () => {
    const { POST } = await import("./route")
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await POST(request({ idempotencyKey: "k", selection }) as never, context)).status).toBe(401)
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    expect((await POST(request({ idempotencyKey: "k", selection }) as never, context)).status).toBe(404)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("maps command conflicts without starting fill or submission", async () => {
    mocks.start.mockRejectedValueOnce(new Error("source graph changed"))
    const { POST } = await import("./route")
    expect((await POST(request({ idempotencyKey: "k", selection }) as never, context)).status).toBe(409)
    expect(mocks.start).toHaveBeenCalledOnce()
  })
})
