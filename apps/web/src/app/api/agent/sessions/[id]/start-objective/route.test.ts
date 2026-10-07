import { beforeEach, describe, expect, it, vi } from "vitest"
import { schemaVersion } from "@jobcopilot/agent-protocol"

const mocks = vi.hoisted(() => {
  class MockAgentCommandError extends Error {
    constructor(readonly code: string, message: string, readonly status: number, readonly details: Record<string, unknown> = {}) {
      super(message)
    }
  }
  return { requireAuth: vi.fn(), start: vi.fn(), resumeFindMany: vi.fn(), MockAgentCommandError }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: { resume: { findMany: mocks.resumeFindMany } } }))

vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandError: mocks.MockAgentCommandError,
  ObjectiveStartCommandService: class { start = mocks.start },
}))

const params = { params: Promise.resolve({ id: "session_1" }) }
const context = [{ type: "text", text: "\nReference context stays exact.\n" }]

function body(overrides: Record<string, unknown> = {}) {
  return { schemaVersion, clientMessageId: "start_1", objective: "  Find Dublin roles  ", content: context, ...overrides }
}

function request(value: unknown, key = "start_1") {
  return new Request("http://localhost/api/agent/sessions/session_1/start-objective", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(value),
  })
}

describe("start-objective command API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.start.mockReset()
    mocks.resumeFindMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.resumeFindMany.mockResolvedValue([])
    mocks.start.mockResolvedValue({ inputId: "input_1", turnId: "turn_1", disposition: "started", sequence: "7" })
  })

  it("dispatches an authenticated user-only command with a distinct normalized objective and unchanged context", async () => {
    const { POST } = await import("./route")
    const response = await POST(request(body()) as never, params)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ turnId: "turn_1", disposition: "started" })
    expect(mocks.start).toHaveBeenCalledWith({
      sessionId: "session_1", userId: "user_1", clientMessageId: "start_1", source: "user",
      objective: "Find Dublin roles", content: context,
    })
  })

  it("rejects mismatched idempotency and all client authority fields before service dispatch", async () => {
    for (const [value, key] of [
      [body({ source: "automation" }), "start_1"],
      [body({ userId: "other" }), "start_1"],
      [body({ delivery: "steer" }), "start_1"],
      [body({ criteria: ["must pass"] }), "start_1"],
      [body({ expectedTurnId: "turn_1" }), "start_1"],
      [body(), "different"],
    ] as const) {
      const { POST } = await import("./route")
      expect((await POST(request(value, key) as never, params)).status).toBe(422)
    }
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("checks attachment ownership and maps typed Session state conflicts", async () => {
    const attachmentContent = [...context, { type: "attachment_ref", attachmentId: "resume_1", mediaType: "application/pdf" }]
    mocks.resumeFindMany.mockResolvedValueOnce([{ id: "resume_1" }])
    const { POST } = await import("./route")
    const accepted = await POST(request(body({ content: attachmentContent })) as never, params)
    expect(accepted.status).toBe(202)
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ content: attachmentContent }))

    mocks.start.mockRejectedValueOnce(new mocks.MockAgentCommandError(
      "objective_start_state_conflict", "The Session must be running to start a new objective", 409, { status: "paused" },
    ))
    const conflict = await POST(request(body()) as never, params)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "objective_start_state_conflict", details: { status: "paused" } } })
  })

  it("rejects foreign attachments and unauthenticated calls without admission", async () => {
    const { POST } = await import("./route")
    const foreign = await POST(request(body({ content: [...context, { type: "attachment_ref", attachmentId: "foreign", mediaType: "application/pdf" }] })) as never, params)
    expect(foreign.status).toBe(422)
    await expect(foreign.json()).resolves.toMatchObject({ error: { code: "attachment_not_owned" } })

    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const unauthorized = await POST(request(body()) as never, params)
    expect(unauthorized.status).toBe(401)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("keeps the existing 256 KiB raw body bound", async () => {
    const oversized = body({ content: Array.from({ length: 14 }, () => ({ type: "text", text: "x".repeat(20_000) })) })
    const { POST } = await import("./route")
    const response = await POST(request(oversized) as never, params)
    expect(response.status).toBe(422)
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
