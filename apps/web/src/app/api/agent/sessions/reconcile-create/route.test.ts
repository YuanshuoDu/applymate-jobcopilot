import { createHash } from "node:crypto"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), reconcile: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/session/agent-session-create-idempotency", () => ({
  reconcileIdempotentAgentSession: mocks.reconcile,
}))

const accountScope = (userId: string) => createHash("sha256").update(`applymate:task-start-recovery:${userId}`).digest("hex")

function request(body: string, headers?: Record<string, string>) {
  return new NextRequest("http://localhost/api/agent/sessions/reconcile-create", {
    method: "POST", headers: { "content-type": "application/json", "x-expected-account-scope": accountScope("owner-1"), ...headers }, body,
  })
}

describe("Session creation reconciliation API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "owner-1" })
    mocks.reconcile.mockReset().mockResolvedValue({ state: "unknown" })
  })

  it("returns only found Session identity or unknown for the authenticated owner", async () => {
    const { POST } = await import("./route")
    const found = await POST(request(JSON.stringify({ idempotencyKey: "attempt-1" })))
    expect(found.status).toBe(200)
    expect(found.headers.get("cache-control")).toBe("private, no-store")
    expect(found.headers.get("x-account-scope")).toBe(accountScope("owner-1"))
    await expect(found.json()).resolves.toEqual({ accountScope: accountScope("owner-1"), state: "unknown" })
    expect(mocks.reconcile).toHaveBeenCalledWith({}, "owner-1", "attempt-1")

    mocks.reconcile.mockResolvedValueOnce({ state: "found", sessionId: "session-1" })
    await expect((await POST(request(JSON.stringify({ idempotencyKey: "attempt-1" })))).json())
      .resolves.toEqual({ accountScope: accountScope("owner-1"), state: "found", sessionId: "session-1" })
  })

  it("rejects unknown, oversized, and non-visible creation keys before lookup", async () => {
    const { POST } = await import("./route")
    const invalid = [
      "not-json",
      JSON.stringify({ idempotencyKey: "attempt-1", userId: "other" }),
      JSON.stringify({ idempotencyKey: "" }),
      JSON.stringify({ idempotencyKey: "has space" }),
      JSON.stringify({ idempotencyKey: "x".repeat(129) }),
    ]
    for (const body of invalid) expect((await POST(request(body))).status).toBe(422)
    expect((await POST(request(JSON.stringify({ idempotencyKey: "x".repeat(1024) })))).status).toBe(422)
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  it("rejects unauthenticated lookups without contacting the helper", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { POST } = await import("./route")
    expect((await POST(request(JSON.stringify({ idempotencyKey: "attempt-1" })))).status).toBe(401)
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  it("rejects a prior account's expected scope before reconciling the same creation key", async () => {
    mocks.requireAuth.mockResolvedValueOnce({ userId: "owner-2" })
    const { POST } = await import("./route")
    const response = await POST(request(JSON.stringify({ idempotencyKey: "same-key" }), {
      "x-expected-account-scope": accountScope("owner-1"),
    }))
    expect(response.status).toBe(409)
    expect(response.headers.get("x-account-scope")).toBe(accountScope("owner-2"))
    await expect(response.json()).resolves.toMatchObject({ accountScope: accountScope("owner-2") })
    const missingScope = await POST(new NextRequest("http://localhost/api/agent/sessions/reconcile-create", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "same-key" }),
    }))
    expect(missingScope.status).toBe(409)
    expect(missingScope.headers.get("x-account-scope")).toBe(accountScope("owner-1"))
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  it("does not expose transaction or consent-lock errors", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("private transaction detail"))
    const { POST } = await import("./route")
    const response = await POST(request(JSON.stringify({ idempotencyKey: "attempt-1" })))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: "Could not reconcile Session creation" })
  })
})
