import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), sessionFindFirst: vi.fn(), turnFindMany: vi.fn(), turnFindFirst: vi.fn(), inputCount: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: { agentSession: { findFirst: mocks.sessionFindFirst }, agentTurn: { findMany: mocks.turnFindMany, findFirst: mocks.turnFindFirst }, agentInput: { count: mocks.inputCount } } }))

const params = { params: Promise.resolve({ id: "session_1" }) }

function request(path = "") {
  return new Request(`http://localhost/api/agent/sessions/session_1/turns${path}`)
}

function turn(id: string, index: number) {
  return {
    id, sessionId: "session_1", source: "user", status: "completed", revision: 1, input: { goal: `Goal ${index}`, content: [{ type: "text", text: "private" }] },
    createdAt: new Date(`2026-08-31T01:${String(index).padStart(2, "0")}:00.000Z`), updatedAt: new Date(`2026-08-31T01:${String(index).padStart(2, "0")}:01.000Z`), completedAt: new Date(`2026-08-31T01:${String(index).padStart(2, "0")}:01.000Z`),
    steps: [], items: [],
  }
}

describe("agent turns query API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset(); mocks.sessionFindFirst.mockReset(); mocks.turnFindMany.mockReset(); mocks.turnFindFirst.mockReset(); mocks.inputCount.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.turnFindMany.mockResolvedValue([turn("turn_1", 1)])
    mocks.turnFindFirst.mockResolvedValue({ id: "turn_1", status: "in_progress", revision: 3 })
    mocks.inputCount.mockResolvedValue(2)
  })

  it("returns safe turn DTOs with active-turn and queued-input projection", async () => {
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: "agent-harness.v2",
      turns: [{ id: "turn_1", goal: "Goal 1", activeStepId: null, finalItemId: null }],
      projection: { activeTurnId: "turn_1", activeTurn: { status: "in_progress", revision: 3 }, queuedInputCount: 2 },
    })
    expect(mocks.turnFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", userId: "user_1" }, take: 51,
    }))
    expect(mocks.inputCount).toHaveBeenCalledWith({ where: { sessionId: "session_1", userId: "user_1", status: "accepted", delivery: "follow_up" } })
  })

  it("returns 404 for a foreign session and does not read turn state", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(404)
    expect(mocks.turnFindMany).not.toHaveBeenCalled()
    expect(mocks.inputCount).not.toHaveBeenCalled()
  })

  it("rejects invalid cursors before database access", async () => {
    const { GET } = await import("./route")
    const response = await GET(request("?cursor=invalid") as never, params)
    expect(response.status).toBe(400)
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
  })
})
