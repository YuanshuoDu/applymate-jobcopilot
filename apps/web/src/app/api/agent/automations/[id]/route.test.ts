import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
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
      updateMany: mocks.updateMany,
      findFirst: mocks.findFirst,
      deleteMany: mocks.deleteMany,
    },
  },
}))

type RouteCtx = { params: Promise<{ id: string }> }

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/agent/automations/automation_1", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

function deleteRequest() {
  return new Request("http://localhost/api/agent/automations/automation_1", { method: "DELETE" })
}

function ctx(id = "automation_1"): RouteCtx {
  return { params: Promise.resolve({ id }) }
}

describe("agent automation detail API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.updateMany.mockReset()
    mocks.findFirst.mockReset()
    mocks.deleteMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
  })

  it("updates an automation only for the authenticated user", async () => {
    const updated = {
      id: "automation_1",
      name: "Weekday Berlin SWE Scout",
      enabled: false,
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
      nextRunAt: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:05:00Z"),
    }
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    mocks.findFirst.mockResolvedValueOnce(updated)
    const { PATCH } = await import("./route")

    const res = await PATCH(patchRequest({ enabled: false }) as never, ctx())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      automation: {
        id: "automation_1",
        enabled: false,
        updatedAt: "2026-06-18T08:05:00.000Z",
      },
    })
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1" },
      data: { enabled: false },
    })
  })

  it("returns 404 when updating a missing automation", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    const { PATCH } = await import("./route")

    const res = await PATCH(patchRequest({ enabled: true }) as never, ctx())

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: "Automation not found" })
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })

  it("recomputes nextRunAt when cron changes", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    mocks.findFirst.mockResolvedValueOnce({
      cron: "0 8 * * *",
      timezone: "Europe/Berlin",
    })
    mocks.findFirst.mockResolvedValueOnce({
      id: "automation_1",
      name: "Daily scout",
      enabled: true,
      triggerType: "daily",
      cron: "0 9 * * *",
      timezone: "Europe/Berlin",
      targetRoles: [],
      targetLocations: [],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: false,
      createdBy: "user",
      lastRunAt: null,
      nextRunAt: new Date("2026-06-23T09:00:00Z"),
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:05:00Z"),
    })
    const { PATCH } = await import("./route")

    const res = await PATCH(patchRequest({ cron: "0 9 * * *" }) as never, ctx())

    expect(res.status).toBe(200)
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1" },
      data: { cron: "0 9 * * *", nextRunAt: expect.any(Date) },
    })
  })

  it("recomputes nextRunAt when timezone changes", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    mocks.findFirst.mockResolvedValueOnce({
      cron: "0 9 * * *",
      timezone: "UTC",
    })
    mocks.findFirst.mockResolvedValueOnce({
      id: "automation_1",
      name: "Daily scout",
      enabled: true,
      triggerType: "daily",
      cron: "0 9 * * *",
      timezone: "Europe/Berlin",
      targetRoles: [],
      targetLocations: [],
      minScore: 85,
      dailyCap: 8,
      requireApproval: true,
      autoApply: false,
      createdBy: "user",
      lastRunAt: null,
      nextRunAt: new Date("2026-06-23T07:00:00Z"),
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:05:00Z"),
    })
    const { PATCH } = await import("./route")

    const res = await PATCH(patchRequest({ timezone: "Europe/Berlin" }) as never, ctx())

    expect(res.status).toBe(200)
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1" },
      data: { timezone: "Europe/Berlin", nextRunAt: expect.any(Date) },
    })
  })

  it("deletes an automation only for the authenticated user", async () => {
    mocks.deleteMany.mockResolvedValueOnce({ count: 1 })
    const { DELETE } = await import("./route")

    const res = await DELETE(deleteRequest() as never, ctx())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { id: "automation_1", userId: "user_1" },
    })
  })
})
