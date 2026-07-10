import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  automationFindMany: vi.fn(),
  automationUpdateMany: vi.fn(),
  sessionCreate: vi.fn(),
  transcriptCreate: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentAutomation: {
      findMany: mocks.automationFindMany,
      updateMany: mocks.automationUpdateMany,
    },
    agentSession: { create: mocks.sessionCreate },
    agentTranscriptEvent: { create: mocks.transcriptCreate },
  },
}))

function postRequest(headers?: HeadersInit) {
  return new Request("http://localhost/api/agent/automations/due", { method: "POST", headers })
}

function getRequest(headers?: HeadersInit) {
  return new Request("http://localhost/api/agent/automations/due", { method: "GET", headers })
}

describe("agent automation due scheduler API", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    vi.stubEnv("AGENT_AUTOMATION_CRON_SECRET", "")
    mocks.automationFindMany.mockResolvedValue([
      {
        id: "automation_1",
        userId: "user_1",
        name: "Weekday Berlin SWE Scout",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Berlin",
        triggerType: "weekdays",
        targetRoles: ["SWE"],
        targetLocations: ["Berlin"],
        minScore: 85,
        dailyCap: 8,
        requireApproval: true,
        autoApply: true,
      },
    ])
    mocks.sessionCreate.mockResolvedValue({ id: "session_1" })
    mocks.transcriptCreate.mockResolvedValue({ id: "event_1" })
    mocks.automationUpdateMany.mockResolvedValue({ count: 1 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("starts due enabled automations as AgentSessions", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      started: [{ automationId: "automation_1", sessionId: "session_1" }],
    })
    expect(mocks.automationFindMany).toHaveBeenCalledWith({
      where: { enabled: true, nextRunAt: { lte: expect.any(Date) } },
      orderBy: { nextRunAt: "asc" },
      take: 20,
    })
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Run automation: Weekday Berlin SWE Scout",
        source: "automation",
        status: "running",
        memorySummary: "Automation picked up by scheduler.",
      },
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "session_1",
        type: "automation_started",
        body: "Started scheduled automation: Weekday Berlin SWE Scout",
      }),
    })
    expect(mocks.automationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "automation_1",
        userId: "user_1",
        enabled: true,
        nextRunAt: { lte: expect.any(Date) },
      },
      data: { lastRunAt: expect.any(Date), nextRunAt: expect.any(Date) },
    })
  })

  it("skips session creation when another scheduler already claimed the automation", async () => {
    mocks.automationUpdateMany.mockResolvedValueOnce({ count: 0 })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ started: [] })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
  })

  it("requires the configured cron secret", async () => {
    vi.stubEnv("AGENT_AUTOMATION_CRON_SECRET", "cron-secret")
    const { POST } = await import("./route")

    const rejected = await POST(postRequest() as never)
    const accepted = await POST(postRequest({ authorization: "Bearer cron-secret" }) as never)

    expect(rejected.status).toBe(401)
    expect(accepted.status).toBe(200)
  })

  it("accepts Vercel CRON_SECRET as a fallback secret", async () => {
    vi.stubEnv("AGENT_AUTOMATION_CRON_SECRET", "")
    vi.stubEnv("CRON_SECRET", "vercel-cron-secret")
    const { POST } = await import("./route")

    const res = await POST(postRequest({ "x-agent-cron-secret": "vercel-cron-secret" }) as never)

    expect(res.status).toBe(200)
  })

  it("supports Vercel Cron GET requests with bearer CRON_SECRET", async () => {
    vi.stubEnv("CRON_SECRET", "vercel-cron-secret")
    const { GET } = await import("./route")

    const res = await GET(getRequest({ authorization: "Bearer vercel-cron-secret" }) as never)

    expect(res.status).toBe(200)
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: "automation",
        status: "running",
      }),
    })
  })
})
