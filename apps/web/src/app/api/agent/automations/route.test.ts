import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
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
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      create: mocks.create,
      update: mocks.update,
    },
  },
}))

function getRequest() {
  return new Request("http://localhost/api/agent/automations")
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/agent/automations", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("agent automations API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findMany.mockReset()
    mocks.findFirst.mockReset()
    mocks.create.mockReset()
    mocks.update.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.findFirst.mockResolvedValue(null)
  })

  it("lists automations for the authenticated user", async () => {
    const rows = [
      {
        id: "automation_1",
        name: "Weekday Berlin SWE Scout",
        enabled: true,
        triggerType: "weekdays",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Berlin",
        targetRoles: ["Software Engineer"],
        targetLocations: ["Berlin"],
        minScore: 85,
        dailyCap: 8,
        requireApproval: true,
        autoApply: true,
        createdBy: "user",
        lastRunAt: null,
        nextRunAt: new Date("2026-06-19T08:00:00Z"),
        createdAt: new Date("2026-06-18T08:00:00Z"),
        updatedAt: new Date("2026-06-18T08:03:00Z"),
      },
    ]
    mocks.findMany.mockResolvedValueOnce(rows)
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      automations: [
        {
          ...rows[0],
          lastRunAt: null,
          nextRunAt: "2026-06-19T08:00:00.000Z",
          createdAt: "2026-06-18T08:00:00.000Z",
          updatedAt: "2026-06-18T08:03:00.000Z",
        },
      ],
    })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
    })
  })

  it("creates a weekday automation with normalized fields", async () => {
    mocks.create.mockResolvedValueOnce({
      id: "automation_1",
      userId: "user_1",
      name: "Weekday Berlin SWE Scout",
      enabled: true,
      triggerType: "weekdays",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
      targetRoles: ["Software Engineer"],
      targetLocations: ["Berlin"],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: true,
      createdBy: "agent",
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:00:00Z"),
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest({
      name: "  Weekday Berlin SWE Scout  ",
      triggerType: "weekdays",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Berlin",
      targetRoles: [" Software Engineer ", ""],
      targetLocations: [" Berlin "],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: true,
      createdBy: "agent",
    }) as never)

    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toMatchObject({
      mode: "created_new",
      automation: {
        id: "automation_1",
        name: "Weekday Berlin SWE Scout",
        createdBy: "agent",
      },
    })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { userId: "user_1", name: "Weekday Berlin SWE Scout" },
      select: { id: true },
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        name: "Weekday Berlin SWE Scout",
        enabled: true,
        triggerType: "weekdays",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Berlin",
        targetRoles: ["Software Engineer"],
        targetLocations: ["Berlin"],
        minScore: 85,
        dailyCap: 8,
        requireApproval: true,
        autoApply: true,
        createdBy: "agent",
        nextRunAt: expect.any(Date),
      },
    })
  })

  it("updates an existing same-name automation instead of creating a duplicate", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "automation_1" })
    mocks.update.mockResolvedValueOnce({
      id: "automation_1",
      userId: "user_1",
      name: "Weekday Berlin SWE Scout",
      enabled: true,
      triggerType: "daily",
      cron: "0 8 * * *",
      timezone: "Europe/Berlin",
      targetRoles: ["SWE"],
      targetLocations: ["Berlin"],
      minScore: 90,
      dailyCap: 4,
      requireApproval: true,
      autoApply: false,
      createdBy: "user",
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:10:00Z"),
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest({
      name: "Weekday Berlin SWE Scout",
      triggerType: "daily",
      cron: "0 8 * * *",
      timezone: "Europe/Berlin",
      targetRoles: ["SWE"],
      targetLocations: ["Berlin"],
      minScore: 90,
      dailyCap: 4,
      requireApproval: true,
      autoApply: false,
    }) as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      mode: "updated_existing",
      automation: { id: "automation_1", minScore: 90 },
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: expect.objectContaining({
        userId: "user_1",
        name: "Weekday Berlin SWE Scout",
        triggerType: "daily",
        minScore: 90,
        dailyCap: 4,
      }),
    })
  })

  it("rejects automation creation without a name", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest({ name: " " }) as never)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "Automation name is required" })
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
