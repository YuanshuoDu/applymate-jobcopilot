import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    agentSession: {
      findFirst: mocks.findFirst,
    },
  },
}))

function getRequest() {
  return new Request("http://localhost/api/agent/sessions/session_1")
}

const params = { params: Promise.resolve({ id: "session_1" }) }

describe("agent session detail API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findFirst.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
  })

  it("returns a session with task and approval summaries for the owner", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "session_1",
      goal: "Apply to Berlin SWE roles",
      status: "running",
      source: "manual_run",
      memorySummary: "Processed 10 jobs · applied 4",
      qualityScore: 87,
      currentTaskId: "task_1",
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:05:00Z"),
      completedAt: null,
      tasks: [
        {
          id: "task_1",
          role: "scout",
          taskType: "liveness_gate",
          status: "passed",
          confidence: 0.94,
          failureReason: null,
          createdAt: new Date("2026-06-18T08:01:00Z"),
          updatedAt: new Date("2026-06-18T08:02:00Z"),
        },
      ],
      approvals: [
        {
          id: "approval_1",
          type: "apply_jobs",
          status: "pending",
          title: "Submit 4 applications",
          createdAt: new Date("2026-06-18T08:03:00Z"),
        },
      ],
    })
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      session: {
        id: "session_1",
        goal: "Apply to Berlin SWE roles",
        status: "running",
        source: "manual_run",
        memorySummary: "Processed 10 jobs · applied 4",
        qualityScore: 87,
        currentTaskId: "task_1",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T08:05:00.000Z",
        completedAt: null,
        tasks: [
          {
            id: "task_1",
            role: "scout",
            taskType: "liveness_gate",
            status: "passed",
            confidence: 0.94,
            failureReason: null,
            createdAt: "2026-06-18T08:01:00.000Z",
            updatedAt: "2026-06-18T08:02:00.000Z",
          },
        ],
        approvals: [
          {
            id: "approval_1",
            type: "apply_jobs",
            status: "pending",
            title: "Submit 4 applications",
            createdAt: "2026-06-18T08:03:00.000Z",
          },
        ],
      },
    })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" },
      select: {
        id: true,
        goal: true,
        status: true,
        source: true,
        memorySummary: true,
        qualityScore: true,
        currentTaskId: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        tasks: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            role: true,
            taskType: true,
            status: true,
            confidence: true,
            failureReason: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        approvals: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            type: true,
            status: true,
            title: true,
            createdAt: true,
          },
        },
      },
    })
  })

  it("returns 404 when the session is not owned by the user", async () => {
    mocks.findFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: "Session not found" })
  })

  it("returns auth errors without querying sessions", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(401)
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })
})
