import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    applyResult: {
      findMany: mocks.findMany,
    },
  },
}))

function request() {
  return new Request("http://localhost/api/agent/health")
}

describe("agent health API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
  })

  it("summarizes user-owned apply result health", async () => {
    mocks.findMany.mockResolvedValueOnce([
      { status: "submitted", flowUsed: "pattern-cache", error: null, durationMs: 120000, createdAt: new Date() },
      { status: "failed", flowUsed: "llm", error: "captcha required", durationMs: 180000, createdAt: new Date() },
      { status: "submitted", flowUsed: "programmatic", error: null, durationMs: null, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    ])
    const { GET } = await import("./route")

    const res = await GET(request() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      successRate: 66.7,
      captchaRate: 33.3,
      avgDurationMs: 150000,
      patternCacheRate: 33.3,
      last24hRuns: 2,
    })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        status: true,
        flowUsed: true,
        error: true,
        durationMs: true,
        createdAt: true,
      },
    })
  })

  it("returns zeros when the user has no apply results", async () => {
    mocks.findMany.mockResolvedValueOnce([])
    const { GET } = await import("./route")

    const res = await GET(request() as never)

    await expect(res.json()).resolves.toEqual({
      successRate: 0,
      captchaRate: 0,
      avgDurationMs: 0,
      patternCacheRate: 0,
      last24hRuns: 0,
    })
  })

  it("returns auth errors without querying health data", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")

    const res = await GET(request() as never)

    expect(res.status).toBe(401)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
