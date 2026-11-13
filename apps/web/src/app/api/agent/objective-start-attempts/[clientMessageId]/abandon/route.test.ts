import { createHash } from "node:crypto"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), abandon: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands/objective-start-attempt-ledger", () => ({
  abandonObjectiveStartAttempt: mocks.abandon,
  isValidAttemptKey: (value: unknown) => typeof value === "string" && Boolean(value.trim()) && value.length <= 256 && value === value.trim(),
}))

const context = (clientMessageId: string) => ({ params: Promise.resolve({ clientMessageId }) })
const accountScope = (userId: string) => createHash("sha256").update(`applymate:task-start-recovery:${userId}`).digest("hex")
const request = (scope = accountScope("owner-1")) => new NextRequest("http://localhost/api/agent/objective-start-attempts/key-1/abandon", {
  method: "POST", headers: { "x-expected-account-scope": scope },
})

describe("objective start attempt abandonment API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "owner-1" })
    mocks.abandon.mockReset().mockResolvedValue({ state: "abandoned" })
  })

  it("returns accepted receipt when acceptance already won and does not claim cancellation", async () => {
    const receipt = { sessionId: "session-1", inputId: "input-1", turnId: "turn-1", sequence: "8" }
    mocks.abandon.mockResolvedValueOnce({ state: "accepted", receipt })
    const { POST } = await import("./route")
    const response = await POST(request(), context("key-1"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ accountScope: accountScope("owner-1"), state: "accepted", receipt })
    expect(response.headers.get("x-account-scope")).toBe(accountScope("owner-1"))
    expect(JSON.stringify(body)).not.toMatch(/cancel|stopped/i)
    expect(mocks.abandon).toHaveBeenCalledWith({}, "owner-1", "key-1")
  })

  it("returns abandoned idempotently and preserves unknown when legacy evidence is inconclusive", async () => {
    const { POST } = await import("./route")
    expect(await (await POST(request(), context("key-1"))).json()).toEqual({ accountScope: accountScope("owner-1"), state: "abandoned" })
    mocks.abandon.mockResolvedValueOnce({ state: "unknown" })
    expect(await (await POST(request(), context("key-1"))).json()).toEqual({ accountScope: accountScope("owner-1"), state: "unknown" })
    mocks.abandon.mockResolvedValueOnce({ state: "unavailable" })
    expect(await (await POST(request(), context("key-1"))).json()).toEqual({ accountScope: accountScope("owner-1"), state: "unavailable" })
  })

  it("rejects any request body and invalid keys before abandonment", async () => {
    const { POST } = await import("./route")
    const withBody = new NextRequest("http://localhost/api/agent/objective-start-attempts/key-1/abandon", {
      method: "POST", headers: { "content-type": "application/json", "x-expected-account-scope": accountScope("owner-1") }, body: "{}",
    })
    expect((await POST(withBody, context("key-1"))).status).toBe(422)
    expect((await POST(request(), context(" "))).status).toBe(422)
    expect(mocks.abandon).not.toHaveBeenCalled()
  })

  it("does not abandon for an unauthenticated caller", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { POST } = await import("./route")
    expect((await POST(request(), context("key-1"))).status).toBe(401)
    expect(mocks.abandon).not.toHaveBeenCalled()
  })

  it("rejects a prior account's expected scope before abandoning the same key", async () => {
    mocks.requireAuth.mockResolvedValueOnce({ userId: "owner-2" })
    const { POST } = await import("./route")
    const response = await POST(request(accountScope("owner-1")), context("same-key"))
    expect(response.status).toBe(409)
    expect(response.headers.get("x-account-scope")).toBe(accountScope("owner-2"))
    await expect(response.json()).resolves.toMatchObject({ accountScope: accountScope("owner-2") })
    const missingScope = await POST(new NextRequest("http://localhost/api/agent/objective-start-attempts/same-key/abandon", { method: "POST" }), context("same-key"))
    expect(missingScope.status).toBe(409)
    expect(missingScope.headers.get("x-account-scope")).toBe(accountScope("owner-1"))
    expect(mocks.abandon).not.toHaveBeenCalled()
  })
})
