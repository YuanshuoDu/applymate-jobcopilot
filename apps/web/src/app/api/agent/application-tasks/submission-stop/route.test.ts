import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"

const mocks = vi.hoisted(() => {
  class MockApplicationSubmissionStopError extends Error {
    constructor(readonly code: string, message = "private failure") { super(message) }
  }
  return { requireAuth: vi.fn(), transaction: vi.fn(), requestStop: vi.fn(), MockApplicationSubmissionStopError }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }))
vi.mock("../submission-stop", () => ({
  ApplicationSubmissionStopError: mocks.MockApplicationSubmissionStopError,
  requestApplicationSubmissionStopInTransaction: mocks.requestStop,
}))

const tx = { private: "transaction-client" }
const validBody = {
  sessionId: "session-owner",
  applicationTaskId: "application-1",
  expectedAttemptTarget: `ast1_${"a".repeat(64)}`,
}

function request(body: unknown, query = "") {
  return new Request(`http://localhost/api/agent/application-tasks/submission-stop${query}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}

describe("authenticated application submission Stop route", () => {
  beforeEach(() => {
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "authenticated-owner" })
    mocks.requestStop.mockReset().mockResolvedValue("stop_requested")
    mocks.transaction.mockReset().mockImplementation(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("interactive transaction required")
      return (callback as (client: typeof tx) => Promise<unknown>)(tx)
    })
  })

  it("uses the authenticated owner in one RLS transaction and returns only a bounded outcome", async () => {
    const response = await POST(request(validBody) as never)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(response.json()).resolves.toEqual({ outcome: "stop_requested" })
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.transaction.mock.calls[0]?.[0]).toEqual(expect.any(Function))
    expect(mocks.requestStop).toHaveBeenCalledWith(tx, { ...validBody, userId: "authenticated-owner" })
  })

  it("passes through a durable grant-first too_late outcome", async () => {
    mocks.requestStop.mockResolvedValueOnce("too_late")
    const response = await POST(request(validBody) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ outcome: "too_late" })
    expect(mocks.requestStop).toHaveBeenCalledWith(tx, expect.objectContaining({ expectedAttemptTarget: validBody.expectedAttemptTarget }))
  })

  it.each(["submitted", "uncertain"] as const)("preserves the finite %s outcome", async outcome => {
    mocks.requestStop.mockResolvedValueOnce(outcome)
    const response = await POST(request(validBody) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ outcome })
  })

  it.each([
    ["missing field", { sessionId: validBody.sessionId, applicationTaskId: validBody.applicationTaskId }],
    ["extra owner", { ...validBody, userId: "untrusted-owner" }],
    ["extra operation", { ...validBody, action: "cancel" }],
    ["malformed target", { ...validBody, expectedAttemptTarget: "private-target" }],
  ])("rejects a %s request before opening the transaction", async (_label, body) => {
    const response = await POST(request(body) as never)

    expect(response.status).toBe(422)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_submission_stop_request" } })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.requestStop).not.toHaveBeenCalled()
  })

  it("returns authentication errors without opening a transaction", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const response = await POST(request(validBody) as never)

    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("rejects query parameters outside the closed request before opening the transaction", async () => {
    const response = await POST(request(validBody, "?userId=untrusted") as never)

    expect(response.status).toBe(422)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("maps scoped helper conflicts to a bounded uncertain result without exposing error data", async () => {
    mocks.requestStop.mockRejectedValueOnce(new mocks.MockApplicationSubmissionStopError("stop_target_stale", "private identity"))
    const response = await POST(request(validBody) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ outcome: "uncertain" })
  })

  it("does not report stop_requested when transaction commit fails", async () => {
    mocks.transaction.mockImplementationOnce(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("interactive transaction required")
      await (callback as (client: typeof tx) => Promise<unknown>)(tx)
      throw new Error("private commit failure")
    })
    const response = await POST(request(validBody) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ outcome: "uncertain" })
    expect(mocks.requestStop).toHaveBeenCalledTimes(1)
  })

  it("fails closed when the transaction returns an unknown outcome", async () => {
    mocks.requestStop.mockResolvedValueOnce("unknown-private-result")
    let rolledBack = false
    mocks.transaction.mockImplementationOnce(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("interactive transaction required")
      try { return await (callback as (client: typeof tx) => Promise<unknown>)(tx) }
      catch (error) { rolledBack = true; throw error }
    })
    const response = await POST(request(validBody) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ outcome: "uncertain" })
    expect(rolledBack).toBe(true)
  })
})
