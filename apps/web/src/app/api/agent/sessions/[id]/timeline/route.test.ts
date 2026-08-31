import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), sessionFindFirst: vi.fn(), itemFindMany: vi.fn() }))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: { agentSession: { findFirst: mocks.sessionFindFirst }, agentItem: { findMany: mocks.itemFindMany } } }))

const params = { params: Promise.resolve({ id: "session_1" }) }

function item(id: string, index: number) {
  const timestamp = new Date(Date.UTC(2026, 7, 31, 0, 0, index))
  return {
    id, sessionId: "session_1", turnId: "turn_1", stepId: null, taskId: null, type: "agent_message", status: "completed",
    phase: "commentary", revision: 0, content: { text: `Progress ${index}` }, startedAt: null,
    completedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function request(path = "") {
  return new Request(`http://localhost/api/agent/sessions/session_1/timeline${path}`)
}

describe("agent timeline query API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.sessionFindFirst.mockReset()
    mocks.itemFindMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
  })

  it("pages through a 500+ item fixture with a stable createdAt/id cursor", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => item(`item_${index}`, index))
    mocks.itemFindMany.mockResolvedValueOnce(rows.slice(0, 51))
    const { GET } = await import("./route")
    const first = await GET(request("?limit=50") as never, params)
    const firstBody = await first.json()
    expect(first.status).toBe(200)
    expect(firstBody.items).toHaveLength(50)
    expect(firstBody.items[0].id).toBe("item_0")
    expect(firstBody.items[49].id).toBe("item_49")
    expect(firstBody.page).toMatchObject({ hasMore: true })

    mocks.itemFindMany.mockResolvedValueOnce(rows.slice(50, 101))
    const second = await GET(request(`?limit=50&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`) as never, params)
    const secondBody = await second.json()
    expect(secondBody.items[0].id).toBe("item_50")
    expect(secondBody.items.some((entry: { id: string }) => entry.id === "item_49")).toBe(false)
    expect(mocks.itemFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { sessionId: "session_1", OR: expect.any(Array) }, take: 51,
    }))
  })

  it("returns 404 for a cross-tenant session before reading items", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_not_found" } })
    expect(mocks.itemFindMany).not.toHaveBeenCalled()
  })

  it("returns display-safe item DTOs and never reads execution or raw events", async () => {
    mocks.itemFindMany.mockResolvedValueOnce([{
      ...item("artifact_1", 1), type: "artifact", content: { title: "Resume", data: { accessToken: "secret", resumeContent: "private" } },
    }])
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    const body = await response.json()
    expect(body.items[0].content).toEqual({ title: "Resume", data: { accessToken: "[REDACTED]", resumeContent: "[REDACTED]" } })
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
  })

  it("returns auth errors without querying the session", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { GET } = await import("./route")
    const response = await GET(request() as never, params)
    expect(response.status).toBe(401)
    expect(mocks.sessionFindFirst).not.toHaveBeenCalled()
  })
})
