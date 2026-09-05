import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: { agentRun: { findFirst: mocks.findFirst } },
}))

const params = { params: Promise.resolve({ id: "run_1" }) }

function request() {
  return new Request("http://localhost/api/agent/run/run_1/archive")
}

describe("agent run archive API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findFirst.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
  })

  it("returns an ownership-scoped safe historical DTO", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "run_1",
      status: "completed",
      durationMs: 12_345,
      stagesCompleted: 6,
      jobsFound: 18,
      createdAt: new Date("2026-09-05T10:00:00.000Z"),
      report: { output: "private report" },
      log: [{ prompt: "private prompt", email: "private@example.com" }],
    })
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      run: {
        schemaVersion: "agent-harness.v2",
        id: "run_1",
        status: "completed",
        durationMs: 12_345,
        stagesCompleted: 6,
        jobsFound: 18,
        createdAt: "2026-09-05T10:00:00.000Z",
      },
    })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "run_1", userId: "user_1" },
      select: {
        id: true,
        status: true,
        durationMs: true,
        stagesCompleted: true,
        jobsFound: true,
        createdAt: true,
      },
    })
  })

  it("returns 404 for missing or foreign runs", async () => {
    mocks.findFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "Agent run not found" })
  })

  it("returns auth errors without reading a run", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")

    const response = await GET(request() as never, params)

    expect(response.status).toBe(401)
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })
})
