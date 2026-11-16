import { createHash } from "node:crypto"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), get: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands/objective-start-attempt-ledger", () => ({
  getObjectiveStartAttempt: mocks.get,
  isValidAttemptKey: (value: unknown) => typeof value === "string" && Boolean(value.trim()) && value.length <= 256 && value === value.trim(),
}))

const accountScope = (userId: string) => createHash("sha256").update(`applymate:task-start-recovery:${userId}`).digest("hex")
const context = (clientMessageId: string) => ({ params: Promise.resolve({ clientMessageId }) })
const request = (scope = accountScope("owner-1")) => new NextRequest("http://localhost/api/agent/objective-start-attempts/key-1", {
  headers: { "x-expected-account-scope": scope },
})

describe("objective start attempt receipt API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "owner-1" })
    mocks.get.mockReset().mockResolvedValue({ state: "unknown" })
  })

  it("returns an accepted bounded receipt scoped to the authenticated owner", async () => {
    const receipt = { sessionId: "session-1", inputId: "input-1", turnId: "turn-1", sequence: "8" }
    mocks.get.mockResolvedValueOnce({ state: "accepted", receipt })
    const { GET } = await import("./route")
    const response = await GET(request(), context("key-1"))

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-account-scope")).toBe(accountScope("owner-1"))
    await expect(response.json()).resolves.toEqual({ accountScope: accountScope("owner-1"), state: "accepted", receipt })
    expect(mocks.get).toHaveBeenCalledWith({}, "owner-1", "key-1")
  })

  it("preserves unknown and abandoned as explicit states", async () => {
    const { GET } = await import("./route")
    const recoveryRequest = request()
    const unknown = await GET(recoveryRequest, context("key-1"))
    expect(await unknown.json()).toEqual({ accountScope: accountScope("owner-1"), state: "unknown" })
    mocks.get.mockResolvedValueOnce({ state: "abandoned" })
    const abandoned = await GET(recoveryRequest, context("key-1"))
    expect(await abandoned.json()).toEqual({ accountScope: accountScope("owner-1"), state: "abandoned" })
    mocks.get.mockResolvedValueOnce({ state: "unavailable" })
    const unavailable = await GET(recoveryRequest, context("key-1"))
    expect(await unavailable.json()).toEqual({ accountScope: accountScope("owner-1"), state: "unavailable" })
  })

  it("rejects malformed path keys and unauthenticated reads before lookup", async () => {
    const { GET } = await import("./route")
    expect((await GET(request(), context(" "))).status).toBe(422)
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await GET(request(), context("key-1"))).status).toBe(401)
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it("rejects a prior account's expected scope before looking up the same key", async () => {
    mocks.requireAuth.mockResolvedValueOnce({ userId: "owner-2" })
    const { GET } = await import("./route")
    const response = await GET(request(accountScope("owner-1")), context("same-key"))
    expect(response.status).toBe(409)
    expect(response.headers.get("x-account-scope")).toBe(accountScope("owner-2"))
    await expect(response.json()).resolves.toMatchObject({ accountScope: accountScope("owner-2") })
    const missingScope = await GET(new NextRequest("http://localhost/api/agent/objective-start-attempts/same-key"), context("same-key"))
    expect(missingScope.status).toBe(409)
    expect(missingScope.headers.get("x-account-scope")).toBe(accountScope("owner-1"))
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it("does not expose database error details", async () => {
    mocks.get.mockRejectedValueOnce(new Error("private SQL detail"))
    const { GET } = await import("./route")
    const response = await GET(request(), context("key-1"))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: "Could not read objective start recovery state" })
  })
})
