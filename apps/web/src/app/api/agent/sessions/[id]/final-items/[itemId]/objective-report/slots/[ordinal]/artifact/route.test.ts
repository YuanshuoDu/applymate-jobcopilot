import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: vi.fn(), transaction: vi.fn(), tenant: vi.fn(), read: vi.fn() }))
vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth, isErrorResponse: (value: unknown) => value instanceof Response }))
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }))
vi.mock("@/lib/db/tenant-store", () => ({ runWithTenantContext: mocks.tenant }))
vi.mock("@/lib/agent/session/objective-slot-artifact", () => ({ readObjectiveSlotArtifactEvidence: mocks.read }))

const sessionId = "session-1", itemId = "final-1", ordinal = "2", graphRevision = 8
const evidence = { schemaVersion: "agent-harness.v2.objective-slot-artifact.v1", graphRevision, slotOrdinal: 2,
  artifactRef: { artifactId: "opaque-artifact", version: 3, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` } }
const context = { params: Promise.resolve({ id: sessionId, itemId, ordinal }) }
const request = (url = `http://localhost/api/agent/sessions/${sessionId}/final-items/${itemId}/objective-report/slots/${ordinal}/artifact?graphRevision=${graphRevision}`) => new Request(url)

describe("Objective slot artifact route", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ userId: "user-1" })
    mocks.tenant.mockImplementation(async (_userId: string, run: () => Promise<unknown>) => run())
    mocks.transaction.mockImplementation(async (run: (tx: unknown, options: unknown) => Promise<unknown>) => run({ tx: true }, {}))
    mocks.read.mockResolvedValue(evidence)
  })

  it("returns only the closed reference after an owner-scoped RepeatableRead", async () => {
    const { GET } = await import("./route")
    const response = await GET(request() as never, context)
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(await response.json()).toEqual({ artifactEvidence: evidence })
    expect(mocks.tenant).toHaveBeenCalledWith("user-1", expect.any(Function))
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" })
    expect(mocks.read).toHaveBeenCalledWith({ tx: true }, { userId: "user-1", sessionId, finalItemId: itemId, graphRevision, slotOrdinal: 2 })
  })

  it("rejects malformed or extra selections before opening a transaction", async () => {
    const { GET } = await import("./route")
    const wrongRevision = await GET(new Request(request().url.replace("graphRevision=8", "graphRevision=08")) as never, context)
    const extra = await GET(new Request(`${request().url}&extra=1`) as never, context)
    expect(wrongRevision.status).toBe(404)
    expect(extra.status).toBe(404)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("conceals missing evidence and anonymous callers", async () => {
    const { GET } = await import("./route")
    mocks.read.mockResolvedValueOnce(null)
    const unavailable = await GET(request() as never, context)
    expect(unavailable.status).toBe(404)
    mocks.auth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const denied = await GET(request() as never, context)
    expect(denied.status).toBe(401)
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
  })
})
