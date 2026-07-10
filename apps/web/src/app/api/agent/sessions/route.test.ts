import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
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
      findMany: mocks.findMany,
      create: mocks.create,
    },
  },
}))

function getRequest() {
  return new Request("http://localhost/api/agent/sessions")
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/agent/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("agent sessions API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findMany.mockReset()
    mocks.create.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
  })

  it("lists recent sessions for the authenticated user", async () => {
    const rows = [
      {
        id: "session_1",
        goal: "Apply to Berlin SWE roles",
        status: "running",
        source: "chat",
        memorySummary: "Berlin SWE, 85+, approval required",
        qualityScore: 87,
        currentTaskId: "task_1",
        createdAt: new Date("2026-06-18T08:00:00Z"),
        updatedAt: new Date("2026-06-18T08:03:00Z"),
        completedAt: null,
      },
    ]
    mocks.findMany.mockResolvedValueOnce(rows)
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      sessions: [
        {
          ...rows[0],
          createdAt: "2026-06-18T08:00:00.000Z",
          updatedAt: "2026-06-18T08:03:00.000Z",
          completedAt: null,
        },
      ],
    })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      orderBy: { createdAt: "desc" },
      take: 50,
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
      },
    })
  })

  it("creates a chat session with trimmed goal text", async () => {
    mocks.create.mockResolvedValueOnce({
      id: "session_1",
      userId: "user_1",
      goal: "Create Berlin SWE automation",
      status: "running",
      source: "chat",
      memorySummary: "",
      qualityScore: null,
      currentTaskId: null,
      createdAt: new Date("2026-06-18T08:00:00Z"),
      updatedAt: new Date("2026-06-18T08:00:00Z"),
      completedAt: null,
    })
    const { POST } = await import("./route")

    const res = await POST(postRequest({ goal: "  Create Berlin SWE automation  " }) as never)

    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toMatchObject({
      session: {
        id: "session_1",
        goal: "Create Berlin SWE automation",
        source: "chat",
        status: "running",
      },
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        goal: "Create Berlin SWE automation",
        source: "chat",
        status: "running",
        memorySummary: "",
      },
    })
  })

  it("rejects session creation without a goal", async () => {
    const { POST } = await import("./route")

    const res = await POST(postRequest({ goal: "   " }) as never)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "Session goal is required" })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns auth errors without querying sessions", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never)

    expect(res.status).toBe(401)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
