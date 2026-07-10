import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  automationFindFirst: vi.fn(),
  automationUpdateMany: vi.fn(),
  sessionCreate: vi.fn(),
  transcriptCreate: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentAutomation: {
      findFirst: mocks.automationFindFirst,
      updateMany: mocks.automationUpdateMany,
    },
    agentSession: { create: mocks.sessionCreate },
    agentTranscriptEvent: { create: mocks.transcriptCreate },
  },
}))

type RouteCtx = { params: Promise<{ id: string }> }

function postRequest() {
  return new Request("http://localhost/api/agent/automations/automation_1/run", { method: "POST" })
}

function ctx(id = "automation_1"): RouteCtx {
  return { params: Promise.resolve({ id }) }
}

describe("agent automation run API", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.automationFindFirst.mockResolvedValue({
      id: "automation_1",
      name: "Weekday Berlin SWE Scout",
      enabled: true,
      cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
      triggerType: "weekdays",
      targetRoles: ["SWE"],
      targetLocations: ["Berlin"],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: true,
    })
    mocks.sessionCreate.mockResolvedValue({
      id: "session_1",
      goal: "Run automation: Weekday Berlin SWE Scout",
      status: "running",
      source: "automation",
      memorySummary: "Automation queued for execution.",
      qualityScore: null,
      currentTaskId: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:00:00Z"),
      completedAt: null,
    })
    mocks.transcriptCreate.mockResolvedValue({
      id: "event_1",
      sessionId: "session_1",
      type: "automation_started",
      speaker: "Orchestrator",
      title: "Automation started",
      body: "Started automation: Weekday Berlin SWE Scout",
      data: { automationId: "automation_1" },
      durationMs: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
    })
    mocks.automationUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("creates an AgentSession for an owned automation run", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toMatchObject({
      session: { id: "session_1", source: "automation" },
      event: { id: "event_1", type: "automation_started" },
    })
    expect(mocks.automationFindFirst).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1" },
    })
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Run automation: Weekday Berlin SWE Scout",
        source: "automation",
        status: "running",
        memorySummary: "Automation queued for execution.",
      },
    })
    expect(mocks.transcriptCreate).toHaveBeenCalledWith({
      data: {
        sessionId: "session_1",
        taskId: null,
        type: "automation_started",
        speaker: "Orchestrator",
        title: "Automation started",
        body: "Started automation: Weekday Berlin SWE Scout",
        data: {
          automationId: "automation_1",
          automation: {
            name: "Weekday Berlin SWE Scout",
            triggerType: "weekdays",
            targetRoles: ["SWE"],
            targetLocations: ["Berlin"],
            minScore: 85,
            dailyCap: 8,
            requireApproval: true,
            autoApply: true,
          },
        },
        durationMs: null,
      },
    })
    expect(mocks.automationUpdateMany).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1", enabled: true },
      data: { lastRunAt: expect.any(Date), nextRunAt: expect.any(Date) },
    })
  })

  it("returns 404 for a missing or unowned automation", async () => {
    mocks.automationFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: "Automation not found" })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("returns 409 without starting a paused automation", async () => {
    mocks.automationFindFirst.mockResolvedValueOnce({
      id: "automation_1",
      name: "Paused Scout",
      enabled: false,
      cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
      triggerType: "weekdays",
      targetRoles: ["SWE"],
      targetLocations: ["Berlin"],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: true,
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Automation is paused" })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
    expect(mocks.automationUpdateMany).not.toHaveBeenCalled()
  })

  it("does not start a session if the automation is paused before claim", async () => {
    mocks.automationUpdateMany.mockResolvedValueOnce({ count: 0 })
    const { POST } = await import("./route")

    const res = await POST(postRequest() as never, ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "Automation is paused" })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.transcriptCreate).not.toHaveBeenCalled()
  })
})
