import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  list: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands/objective-start-attempt-ledger", () => ({
  listObjectiveStartAttempts: mocks.list,
}))

describe("objective start attempt list API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "user_1" })
    mocks.list.mockReset().mockResolvedValue({ accountScope: "opaque", attempts: [] })
  })

  it("returns only the authenticated account's bounded recovery metadata", async () => {
    const { GET } = await import("./route")
    const response = await GET(new NextRequest("http://localhost/api/agent/objective-start-attempts?limit=7"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accountScope: "opaque", attempts: [] })
    expect(response.headers.get("X-Account-Scope")).toBe("opaque")
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mocks.list).toHaveBeenCalledWith({}, "user_1", 7)
  })

  it("rejects malformed limits before querying attempt data", async () => {
    const { GET } = await import("./route")
    for (const limit of ["0", "21", "NaN", "1.5"]) {
      const response = await GET(new NextRequest(`http://localhost/api/agent/objective-start-attempts?limit=${limit}`))
      expect(response.status).toBe(400)
    }
    expect(mocks.list).not.toHaveBeenCalled()
  })
})
