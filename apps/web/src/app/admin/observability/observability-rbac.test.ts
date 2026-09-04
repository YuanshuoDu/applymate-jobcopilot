import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  redirect: vi.fn(),
  getSnapshot: vi.fn(async () => ({
    available: true, kind: "agents", windowMinutes: 1_440, eventCount: 0, latestEventAt: null,
    latestQueueDepth: null, failedEventCount: 0, startedSessions: 0, completedSessions: 0,
    activeTurns: 0, usage: [], openAlerts: [],
  })),
}))

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }))
vi.mock("@/lib/admin/authorization", () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value === "visitor-denied",
}))
vi.mock("@/lib/observability/admin-dashboard", () => ({ getHarnessDashboardSnapshot: mocks.getSnapshot }))

import HarnessAgentsPage from "./agents/page"
import HarnessQueuePage from "./queue/page"
import HarnessSsePage from "./sse/page"
import HarnessUsagePage from "./usage/page"

const pages = [HarnessAgentsPage, HarnessQueuePage, HarnessSsePage, HarnessUsagePage]

describe("Harness observability admin pages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT") })
  })

  it.each(pages)("redirects visitor %s before reading telemetry", async (Page) => {
    mocks.requireAdmin.mockResolvedValueOnce("visitor-denied")
    await expect(Page()).rejects.toThrow("NEXT_REDIRECT")
    expect(mocks.requireAdmin).toHaveBeenCalledWith("observability.read")
    expect(mocks.redirect).toHaveBeenCalledOnce()
    expect(mocks.getSnapshot).not.toHaveBeenCalled()
  })

  it.each(pages)("loads telemetry only for an authorized admin %s", async (Page) => {
    mocks.requireAdmin.mockResolvedValueOnce({ userId: "admin-1", roleKey: "super_admin", permissions: [], requestId: "req-1" })
    await Page()
    expect(mocks.requireAdmin).toHaveBeenCalledWith("observability.read")
    expect(mocks.getSnapshot).toHaveBeenCalledOnce()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
