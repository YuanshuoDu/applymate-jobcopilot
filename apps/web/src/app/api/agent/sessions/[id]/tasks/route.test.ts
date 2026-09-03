import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), sessionFindFirst: vi.fn(), taskFindMany: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: { agentSession: { findFirst: mocks.sessionFindFirst }, subAgentTask: { findMany: mocks.taskFindMany } } }))

const params = { params: Promise.resolve({ id: "session_1" }) }

function request(path = "") {
  return new Request(`http://localhost/api/agent/sessions/session_1/tasks${path}`)
}

describe("agent task query API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset(); mocks.sessionFindFirst.mockReset(); mocks.taskFindMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.taskFindMany.mockResolvedValue([{
      id: "task_1", sessionId: "session_1", role: "scout", taskType: "job_search", status: "passed", goal: "Find EU roles",
      confidence: 0.95, failureReason: null, result: { jobs: [{ id: "job_1" }], resumeText: "private" },
      createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }])
  })

  it("returns a safe task tree DTO without raw result/context", async () => {
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      tasks: [{ id: "task_1", role: "scout", hasResult: true }], page: { hasMore: false, nextCursor: null },
    })
    expect(body.tasks[0]).not.toHaveProperty("result")
    expect(body.tasks[0]).not.toHaveProperty("context")
  })

  it("projects durable completed status to the legacy passed UI status", async () => {
    mocks.taskFindMany.mockResolvedValueOnce([{
      id: "task_2", sessionId: "session_1", role: "scout", taskType: "job_search", status: "completed", goal: "Find EU roles",
      confidence: 1, failureReason: null, result: { jobs: [] },
      createdAt: new Date("2026-08-31T00:00:00Z"), updatedAt: new Date("2026-08-31T00:01:00Z"),
    }])
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect((await response.json()).tasks[0].status).toBe("passed")
  })

  it("uses the authenticated owner guard and supports bounded pagination", async () => {
    const { GET } = await import("./route")
    const response = await GET(request("?limit=10") as never, params)
    expect(response.status).toBe(200)
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 11 }))
  })

  it("returns auth errors without querying tasks", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(401)
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
  })
})
