import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: vi.fn(), snapshot: vi.fn(), decide: vi.fn(), tenantContext: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.auth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/db/tenant-store", () => ({ runWithTenantContext: mocks.tenantContext }))
vi.mock("@/lib/agent/broker/objective-application-review-snapshot", () => ({
  readObjectiveApplicationReviewSnapshot: mocks.snapshot,
}))
vi.mock("@/lib/agent/broker/objective-application-review-decision-service", () => ({
  decideObjectiveApplicationReviewMember: mocks.decide,
}))
vi.mock("../../../command-route-helpers", () => ({
  isResponse: (value: unknown) => value instanceof Response,
  readJsonBody: async (request: Request) => { try { return await request.json() } catch { return Response.json({ error: "invalid" }, { status: 422 }) } },
}))
vi.mock("../../../wait-route-helpers", () => ({
  waitErrorResponse: () => Response.json({ error: { code: "wait_not_pending" } }, { status: 409 }),
}))

const context = { params: Promise.resolve({ id: "session_1", turnId: "review_turn_1" }) }
const snapshot = {
  turnId: "review_turn_1", turnRevision: 5, setStatus: "pending",
  members: [{ slotOrdinal: 3, approvalId: "objective-review:set_1:3", status: "pending", receiptRevision: 2,
    job: { company: "Example GmbH", role: "Engineer" },
    artifactRef: { artifactId: "artifact_3", version: 4, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` },
    resumeId: "resume_1", decisionAvailable: true }],
}
function getRequest() { return new Request("http://localhost/api/agent/sessions/session_1/objective-application-review/review_turn_1") }
function getRequestWithQuery() { return new Request("http://localhost/api/agent/sessions/session_1/objective-application-review/review_turn_1?scopeHash=private") }
function postRequest(body: unknown, contentType: string | null = "application/json") {
  return new Request("http://localhost/api/agent/sessions/session_1/objective-application-review/review_turn_1", {
    method: "POST", headers: contentType ? { "content-type": contentType } : {}, body: JSON.stringify(body),
  })
}

describe("objective application review member route", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.auth.mockReset().mockResolvedValue({ userId: "user_1" })
    mocks.snapshot.mockReset().mockResolvedValue(snapshot)
    mocks.decide.mockReset().mockResolvedValue({ disposition: "resolved", status: "approved", setCompleted: false, nextTurnRevision: 5 })
    mocks.tenantContext.mockReset().mockImplementation(async (_userId: string, callback: () => Promise<unknown>) => callback())
  })

  it("returns only the closed owner snapshot and preserves sparse selected slot ordinals", async () => {
    const { GET } = await import("./route")
    const response = await GET(getRequest() as never, context)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0")
    await expect(response.json()).resolves.toEqual({ snapshot })
    expect(mocks.tenantContext).toHaveBeenCalledWith("user_1", expect.any(Function))
    expect(mocks.snapshot).toHaveBeenCalledWith({}, { userId: "user_1", sessionId: "session_1", turnId: "review_turn_1" })
    expect((await GET(getRequestWithQuery() as never, context)).status).toBe(400)
  })

  it("refuses snapshot rows containing private proof or nonce fields", async () => {
    mocks.snapshot.mockResolvedValueOnce({ ...snapshot, members: [{ ...snapshot.members[0], scopeHash: "private" }] })
    const { GET } = await import("./route")
    const response = await GET(getRequest() as never, context)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "Review status is unavailable" })
  })

  it("submits a strict per-member decision with route-bound turn and no client proof", async () => {
    const body = { approvalId: snapshot.members[0]!.approvalId, expectedRevision: 5, expectedReceiptRevision: 2,
      idempotencyKey: "member-decision-3", decision: "approved" }
    const { POST } = await import("./route")
    const response = await POST(postRequest(body) as never, context)
    expect(response.status).toBe(202)
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0")
    await expect(response.json()).resolves.toEqual({ disposition: "resolved", status: "approved", setCompleted: false, turnRevision: 5 })
    expect(mocks.decide).toHaveBeenCalledWith({}, { approvalId: body.approvalId, userId: "user_1", sessionId: "session_1",
      expectedTurnId: "review_turn_1", expectedRevision: 5, expectedReceiptRevision: 2,
      clientMessageId: "member-decision-3", decision: "approved" })
  })

  it("uses HTTP 200 for exact replay and does not expose internal set identifiers", async () => {
    mocks.decide.mockResolvedValueOnce({ disposition: "duplicate", status: "approved", setCompleted: true,
      nextTurnRevision: 6, waitId: "private_set", itemId: "private_item", approvalId: "private_approval" })
    const { POST } = await import("./route")
    const response = await POST(postRequest({ approvalId: snapshot.members[0]!.approvalId, expectedRevision: 5,
      expectedReceiptRevision: 2, idempotencyKey: "member-decision-3", decision: "approved" }) as never, context)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ disposition: "duplicate", status: "approved", setCompleted: true, turnRevision: 6 })
  })

  it("rejects unauthenticated, non-JSON, and extra proof fields without invoking decisions", async () => {
    const body = { approvalId: snapshot.members[0]!.approvalId, expectedRevision: 5, expectedReceiptRevision: 2,
      idempotencyKey: "decision", decision: "approved" }
    const { POST } = await import("./route")
    mocks.auth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    expect((await POST(postRequest(body) as never, context)).status).toBe(401)
    expect((await POST(postRequest(body, null) as never, context)).status).toBe(422)
    expect((await POST(postRequest({ ...body, scopeHash: "private" }) as never, context)).status).toBe(422)
    expect((await POST(postRequest({ ...body, nonce: "private" }) as never, context)).status).toBe(422)
    expect((await POST(postRequest({ ...body, expectedReceiptRevision: -1 }) as never, context)).status).toBe(422)
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it("maps owner decision conflicts without returning internal details", async () => {
    mocks.decide.mockRejectedValueOnce(new Error("private database detail"))
    const { POST } = await import("./route")
    const response = await POST(postRequest({ approvalId: snapshot.members[0]!.approvalId, expectedRevision: 5,
      expectedReceiptRevision: 2, idempotencyKey: "member-decision-3", decision: "rejected" }) as never, context)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: { code: "wait_not_pending" } })
  })
})
