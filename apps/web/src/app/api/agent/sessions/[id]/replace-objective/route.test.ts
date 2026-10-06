import { beforeEach, describe, expect, it, vi } from "vitest"
import { schemaVersion } from "@jobcopilot/agent-protocol"

const mocks = vi.hoisted(() => {
  class MockAgentCommandError extends Error {
    code: string
    status: number
    details: Record<string, unknown>

    constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
      super(message)
      this.code = code
      this.status = status
      this.details = details
    }
  }
  return { requireAuth: vi.fn(), replaceObjective: vi.fn(), resumeFindMany: vi.fn(), MockAgentCommandError }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: { resume: { findMany: mocks.resumeFindMany } } }))

vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandError: mocks.MockAgentCommandError,
  AgentCommandService: class {
    replaceObjective = mocks.replaceObjective
  },
}))

const params = { params: Promise.resolve({ id: "session_1" }) }
const content = [{ type: "text", text: "Replace the Berlin search with senior backend roles in Dublin." }]

function body(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion,
    clientMessageId: "replace_1",
    expectedTurnId: "turn_1",
    expectedRevision: 7,
    content,
    ...overrides,
  }
}

function request(value: unknown) {
  return new Request("http://localhost/api/agent/sessions/session_1/replace-objective", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  })
}

describe("replace-objective command API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.replaceObjective.mockReset()
    mocks.resumeFindMany.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.resumeFindMany.mockResolvedValue([])
    mocks.replaceObjective.mockResolvedValue({ inputId: "input_2", turnId: "turn_2", disposition: "started", sequence: "9" })
  })

  it("dispatches the bounded replacement as an authenticated user command", async () => {
    const { POST } = await import("./route")
    const response = await POST(request(body()) as never, params)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ turnId: "turn_2", disposition: "started" })
    expect(mocks.replaceObjective).toHaveBeenCalledWith({
      sessionId: "session_1",
      userId: "user_1",
      clientMessageId: "replace_1",
      source: "user",
      expectedTurnId: "turn_1",
      expectedRevision: 7,
      content,
    })
  })

  it("rejects authority, source, delivery, and unknown fields before service dispatch", async () => {
    for (const forbidden of [
      { source: "automation" },
      { delivery: "follow_up" },
      { userId: "other" },
      { criteria: ["must pass"] },
      { approval: { approved: true } },
      { policy: { canSubmit: true } },
      { unexpected: true },
    ]) {
      const { POST } = await import("./route")
      const response = await POST(request(body(forbidden)) as never, params)
      expect(response.status).toBe(422)
    }
    expect(mocks.replaceObjective).not.toHaveBeenCalled()
  })

  it("checks attachment ownership before service dispatch", async () => {
    const attachmentContent = [{ type: "text", text: "Review the attached resume for Dublin roles." }, { type: "attachment_ref", attachmentId: "resume_1", mediaType: "application/pdf" }]
    mocks.resumeFindMany.mockResolvedValueOnce([{ id: "resume_1" }])
    const { POST } = await import("./route")
    const response = await POST(request(body({ content: attachmentContent })) as never, params)

    expect(response.status).toBe(202)
    expect(mocks.resumeFindMany).toHaveBeenCalledWith({ where: { id: { in: ["resume_1"] }, userId: "user_1" }, select: { id: true } })
    expect(mocks.replaceObjective).toHaveBeenCalledWith(expect.objectContaining({ content: attachmentContent, source: "user" }))
  })

  it("rejects a foreign attachment without calling the command service", async () => {
    const { POST } = await import("./route")
    const response = await POST(request(body({ content: [{ ...content[0] }, { type: "attachment_ref", attachmentId: "resume_other", mediaType: "application/pdf" }] })) as never, params)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "attachment_not_owned" } })
    expect(mocks.replaceObjective).not.toHaveBeenCalled()
  })

  it("does not read or dispatch unauthenticated requests", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { POST } = await import("./route")
    const response = await POST(request(body()) as never, params)

    expect(response.status).toBe(401)
    expect(mocks.replaceObjective).not.toHaveBeenCalled()
  })

  it("preserves typed replacement state and active-Turn conflicts", async () => {
    mocks.replaceObjective.mockRejectedValueOnce(new mocks.MockAgentCommandError(
      "objective_replacement_state_conflict", "The Session must be running to replace its objective", 409, { status: "paused" },
    ))
    const { POST } = await import("./route")
    const paused = await POST(request(body()) as never, params)
    expect(paused.status).toBe(409)
    await expect(paused.json()).resolves.toMatchObject({ error: { code: "objective_replacement_state_conflict", details: { status: "paused" } } })

    mocks.replaceObjective.mockRejectedValueOnce(new mocks.MockAgentCommandError(
      "active_turn_changed", "The active Agent Turn changed before this command was accepted", 409, { expectedTurnId: "turn_1", actualTurnId: "turn_2" },
    ))
    const stale = await POST(request(body()) as never, params)
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "active_turn_changed", details: { actualTurnId: "turn_2" } } })
  })

  it("maps a foreign or missing Session to the command service's 404", async () => {
    mocks.replaceObjective.mockRejectedValueOnce(new mocks.MockAgentCommandError("agent_session_not_found", "Session not found", 404, { sessionId: "session_1" }))
    const { POST } = await import("./route")
    const response = await POST(request(body()) as never, params)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "agent_session_not_found" } })
  })
})
