import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findSession: vi.fn(),
  findEvents: vi.fn(),
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
      findFirst: mocks.findSession,
    },
    agentTranscriptEvent: {
      findMany: mocks.findEvents,
    },
  },
}))

function getRequest() {
  return new Request("http://localhost/api/agent/sessions/session_1/events")
}

const params = { params: Promise.resolve({ id: "session_1" }) }

describe("agent session events API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findSession.mockReset()
    mocks.findEvents.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
  })

  it("returns transcript events for an owned session", async () => {
    mocks.findSession.mockResolvedValueOnce({ id: "session_1" })
    mocks.findEvents.mockResolvedValueOnce([
      {
        id: "event_1",
        taskId: null,
        type: "orchestrator_plan",
        speaker: "Orchestrator",
        title: "Plan",
        body: "Run liveness first.",
        data: { gates: ["LivenessGate"] },
        durationMs: 1200,
        createdAt: new Date("2026-06-18T08:01:00Z"),
      },
    ])
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      events: [
        {
          id: "event_1",
          taskId: null,
          type: "orchestrator_plan",
          speaker: "Orchestrator",
          title: "Plan",
          body: "Run liveness first.",
          data: { gates: ["LivenessGate"] },
          durationMs: 1200,
          createdAt: "2026-06-18T08:01:00.000Z",
        },
      ],
    })
    expect(mocks.findSession).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" },
      select: { id: true },
    })
    expect(mocks.findEvents).toHaveBeenCalledWith({
      where: { sessionId: "session_1" },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: {
        id: true,
        taskId: true,
        type: true,
        speaker: true,
        title: true,
        body: true,
        data: true,
        durationMs: true,
        createdAt: true,
      },
    })
  })

  it("returns 404 without reading events when the session is not owned", async () => {
    mocks.findSession.mockResolvedValueOnce(null)
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: "Session not found" })
    expect(mocks.findEvents).not.toHaveBeenCalled()
  })

  it("returns auth errors without querying", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(401)
    expect(mocks.findSession).not.toHaveBeenCalled()
    expect(mocks.findEvents).not.toHaveBeenCalled()
  })
})
