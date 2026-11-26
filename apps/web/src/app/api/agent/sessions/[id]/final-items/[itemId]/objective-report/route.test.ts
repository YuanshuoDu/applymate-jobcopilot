import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), read: vi.fn(), compare: vi.fn(), tenant: vi.fn() }))
vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth, isErrorResponse: (value: unknown) => value instanceof Response }))
vi.mock("@/lib/db/tenant-store", () => ({ runWithTenantContext: mocks.tenant }))
vi.mock("@/lib/agent/session/objective-journey-report", () => ({ readObjectiveJourneyReport: mocks.read }))
vi.mock("@/lib/agent/session/objective-journey-skill-comparison", () => ({ readObjectiveJourneySkillComparison: mocks.compare }))

const report = { schemaVersion: "agent-harness.v2.objective-journey-report.v1", finalItemId: "final-1", graphRevision: 12,
  sourceCounts: { discoveredJobs: { knownCount: 8, coverage: "complete" }, analyzedJobs: { knownCount: null, coverage: "unavailable" } },
  reviewCoverage: "complete", slots: [] }
const context = { params: Promise.resolve({ id: "session-1", itemId: "final-1" }) }
const request = (url = "http://localhost/api/agent/sessions/session-1/final-items/final-1/objective-report", init?: RequestInit) => new Request(url, init)
const comparison = { schemaVersion: "agent-harness.v2.objective-skill-comparison.v1", finalItemId: "final-1", graphRevision: 12,
  coverage: "complete", skills: [{ label: "TypeScript", evidenceStatus: "confirmed_persona_match", slotOrdinals: [1] }], suggestedTerms: ["TypeScript"] }

describe("Objective journey report route", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" })
    mocks.tenant.mockImplementation(async (_userId, run) => run())
    mocks.read.mockResolvedValue(report)
    mocks.compare.mockResolvedValue(comparison)
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

  it("handles only the exact explicit POST action inside the owner tenant", async () => {
    const { POST } = await import("./route")
    const response = await POST(request(undefined, { method: "POST", body: JSON.stringify({ compareConfirmedSkills: true, graphRevision: 12 }),
      headers: { "Content-Type": "application/json" } }) as never, context)
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    await expect(response.json()).resolves.toEqual({ comparison })
    expect(mocks.tenant).toHaveBeenCalledWith("user-1", expect.any(Function))
    expect(mocks.compare).toHaveBeenCalledWith({ userId: "user-1", sessionId: "session-1", finalItemId: "final-1", graphRevision: 12 })
  })

  it("rejects missing, false, extra, stale-query, and non-positive comparison requests", async () => {
    const { POST } = await import("./route")
    const bodies = [
      {}, { compareConfirmedSkills: false, graphRevision: 12 },
      { compareConfirmedSkills: true, graphRevision: 12, quote: "private" },
      { compareConfirmedSkills: true, graphRevision: 0 },
    ]
    for (const body of bodies) {
      const response = await POST(request(undefined, { method: "POST", body: JSON.stringify(body) }) as never, context)
      expect(response.status).toBe(404)
    }
    const query = await POST(request("http://localhost/api/agent/sessions/session-1/final-items/final-1/objective-report?compare=1", {
      method: "POST", body: JSON.stringify({ compareConfirmedSkills: true, graphRevision: 12 }),
    }) as never, context)
    expect(query.status).toBe(404)
    expect(mocks.compare).not.toHaveBeenCalled()
  })

  it("keeps the normal GET path unchanged and never loads comparison data", async () => {
    const { GET } = await import("./route")
    const response = await GET(request() as never, context)
    expect(response.status).toBe(200)
    expect(mocks.compare).not.toHaveBeenCalled()
  })
})
