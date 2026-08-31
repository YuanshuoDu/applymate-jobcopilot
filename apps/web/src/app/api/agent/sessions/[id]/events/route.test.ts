import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  featureEnabled: vi.fn(),
  findSession: vi.fn(),
  findEvents: vi.fn(),
  findAgentEvents: vi.fn(),
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
    agentEvent: {
      findMany: mocks.findAgentEvents,
    },
    agentTranscriptEvent: {
      findMany: mocks.findEvents,
    },
  },
}))

vi.mock("@/lib/runtime-feature-flags", () => ({
  isRuntimeAgentHarnessFeatureEnabled: mocks.featureEnabled,
}))

function getRequest(path = "", init?: RequestInit) {
  return new Request(`http://localhost/api/agent/sessions/session_1/events${path}`, init)
}

const params = { params: Promise.resolve({ id: "session_1" }) }

describe("agent session events API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.featureEnabled.mockReset()
    mocks.findSession.mockReset()
    mocks.findEvents.mockReset()
    mocks.findAgentEvents.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.featureEnabled.mockResolvedValue(false)
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

  it("does not expose dual-write projector metadata to legacy clients", async () => {
    mocks.findSession.mockResolvedValueOnce({ id: "session_1" })
    mocks.findEvents.mockResolvedValueOnce([{
      id: "event_2",
      taskId: null,
      type: "job_results",
      speaker: "Analyst",
      title: "Jobs",
      body: "N26",
      data: { jobs: [{ id: "job_1" }], __agentHarnessV2: { eventId: "v2_event_2", opaque: false, wrapped: false } },
      durationMs: null,
      createdAt: new Date("2026-06-18T08:02:00Z"),
    }])
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    await expect(res.json()).resolves.toMatchObject({ events: [{ data: { jobs: [{ id: "job_1" }] } }] })
  })

  it("returns auth errors without querying", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")

    const res = await GET(getRequest() as never, params)

    expect(res.status).toBe(401)
    expect(mocks.findSession).not.toHaveBeenCalled()
    expect(mocks.findEvents).not.toHaveBeenCalled()
  })

  it("serves V2 SSE from the durable cursor when the rollout flag is enabled", async () => {
    const controller = new AbortController()
    mocks.featureEnabled.mockResolvedValueOnce(true)
    mocks.findSession.mockResolvedValueOnce({ id: "session_1" })
    mocks.findAgentEvents.mockResolvedValueOnce([{
      id: "event_2",
      sessionId: "session_1",
      turnId: "turn_1",
      itemId: "item_1",
      taskId: null,
      sequence: BigInt(2),
      type: "item.completed",
      actor: "orchestrator",
      correlationId: "turn_1",
      causationId: null,
      idempotencyKey: null,
      payload: { text: "done", accessToken: "private" },
      createdAt: new Date(),
    }])
    const { GET } = await import("./route")

    const res = await GET(getRequest("?afterSequence=1", { signal: controller.signal }) as never, params)
    const reader = res.body?.getReader()
    const first = await reader?.read()
    const text = new TextDecoder().decode(first?.value)

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(text).toContain("event: item.completed")
    expect(text).toContain("id: 2")
    expect(text).toContain('"accessToken":"[REDACTED]"')
    expect(mocks.findAgentEvents).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", sequence: { gt: BigInt(1) } },
    }))

    controller.abort()
    await reader?.cancel()
  })

  it("rejects an invalid durable cursor before querying the session", async () => {
    mocks.featureEnabled.mockResolvedValueOnce(true)
    const { GET } = await import("./route")

    const res = await GET(getRequest("?afterSequence=not-a-sequence") as never, params)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: { code: "invalid_after_sequence" } })
    expect(mocks.findSession).not.toHaveBeenCalled()
  })
})
