import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), read: vi.fn(), tenant: vi.fn() }))
vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth, isErrorResponse: (value: unknown) => value instanceof Response }))
vi.mock("@/lib/db/tenant-store", () => ({ runWithTenantContext: mocks.tenant }))
vi.mock("@/lib/agent/session/objective-journey-report", () => ({ readObjectiveJourneyReport: mocks.read }))

const report = { schemaVersion: "agent-harness.v2.objective-journey-report.v1", finalItemId: "final-1", graphRevision: 12,
  sourceCounts: { discoveredJobs: { knownCount: 8, coverage: "complete" }, analyzedJobs: { knownCount: null, coverage: "unavailable" } },
  reviewCoverage: "complete", slots: [] }
const context = { params: Promise.resolve({ id: "session-1", itemId: "final-1" }) }
const request = (url = "http://localhost/api/agent/sessions/session-1/final-items/final-1/objective-report") => new Request(url)

describe("Objective journey report route", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" })
    mocks.tenant.mockImplementation(async (_userId, run) => run())
    mocks.read.mockResolvedValue(report)
  })

  it("returns the exact report only inside the authenticated tenant context", async () => {
    const { GET } = await import("./route")
    const response = await GET(request() as never, context)
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(await response.json()).toEqual({ report })
    expect(mocks.tenant).toHaveBeenCalledWith("user-1", expect.any(Function))
    expect(mocks.read).toHaveBeenCalledWith({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1" })
  })

  it("passes the closed reported score floor through the private report response", async () => {
    const { GET } = await import("./route")
    const reportV2 = { ...report, schemaVersion: "agent-harness.v2.objective-journey-report.v2",
      reportedScoreFloor: { status: "not_requested" } }
    mocks.read.mockResolvedValue(reportV2)
    const response = await GET(request() as never, context)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(await response.json()).toEqual({ report: reportV2 })
  })

  it("conceals invalid, missing, and unsupported query selections", async () => {
    const { GET } = await import("./route")
    mocks.read.mockResolvedValue(undefined)
    const missing = await GET(request() as never, context)
    const query = await GET(request("http://localhost/api/agent/sessions/session-1/final-items/final-1/objective-report?slot=1") as never, context)
    expect(missing.status).toBe(404)
    expect(query.status).toBe(404)
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it("keeps authorization responses private and does not query for anonymous callers", async () => {
    const { GET } = await import("./route")
    const denied = new Response("denied", { status: 401 })
    mocks.requireAuth.mockResolvedValue(denied)
    const response = await GET(request() as never, context)
    expect(response.status).toBe(401)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
