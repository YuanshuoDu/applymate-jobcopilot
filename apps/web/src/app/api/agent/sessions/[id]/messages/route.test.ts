import { beforeEach, describe, expect, it, vi } from "vitest"

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
  return { requireAuth: vi.fn(), message: vi.fn(), resumeFindMany: vi.fn(), sessionFindFirst: vi.fn(), jobFindFirst: vi.fn(), err: vi.fn(), MockAgentCommandError }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  err: (message: string, status = 400) => Response.json({ error: { message } }, { status }),
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({
  db: {
    resume: { findMany: mocks.resumeFindMany },
    agentSession: { findFirst: mocks.sessionFindFirst },
    job: { findFirst: mocks.jobFindFirst },
  },
}))

vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandError: mocks.MockAgentCommandError,
  AgentCommandService: class {
    message = mocks.message
  },
}))

const params = { params: Promise.resolve({ id: "session_1" }) }

function request(body: unknown) {
  return new Request("http://localhost/api/agent/sessions/session_1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("agent message command API", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.message.mockReset()
    mocks.resumeFindMany.mockReset()
    mocks.sessionFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.err.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.resumeFindMany.mockResolvedValue([])
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.jobFindFirst.mockResolvedValue({ id: "job_1" })
    mocks.message.mockResolvedValue({ inputId: "input_1", turnId: "turn_1", disposition: "started", sequence: "1" })
  })

  it("returns 202 and injects authenticated ownership into the service command", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "client_1", content: [{ type: "text", text: "Find Berlin jobs" }] }) as never, params)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ inputId: "input_1", turnId: "turn_1", disposition: "started", sequence: "1" })
    expect(mocks.message).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session_1", userId: "user_1", source: "user", delivery: "steer" }))
  })

  it("preserves duplicate disposition from the command service", async () => {
    mocks.message.mockResolvedValueOnce({ inputId: "input_1", turnId: "turn_1", disposition: "duplicate", originalDisposition: "started", sequence: "1" })
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "client_retry", content: [{ type: "text", text: "Retry" }] }) as never, params)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ disposition: "duplicate", originalDisposition: "started" })
  })

  it("owner-checks the selected job and passes only typed scope to the canonical command", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({
      clientMessageId: "prepare_1",
      delivery: "follow_up",
      selectedJobPreparation: { jobId: "job_1" },
      content: [{ type: "text", text: "Prepare a cover letter draft for the selected job." }],
    }) as never, params)

    expect(response.status).toBe(202)
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({ where: { id: "session_1", userId: "user_1" }, select: { id: true } })
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({ where: { id: "job_1", userId: "user_1" }, select: { id: true } })
    expect(mocks.message).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session_1", userId: "user_1", selectedJobPreparation: { jobId: "job_1" },
      content: [{ type: "text", text: "Prepare a cover letter draft for the selected job." }],
    }))
  })

  it("rejects a job outside the authenticated user's scope without starting a Turn", async () => {
    mocks.jobFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import("./route")
    const response = await POST(request({
      clientMessageId: "prepare_foreign",
      delivery: "follow_up",
      selectedJobPreparation: { jobId: "job_other" },
      content: [{ type: "text", text: "Prepare a cover letter draft for the selected job." }],
    }) as never, params)

    expect(response.status).toBe(404)
    expect(mocks.message).not.toHaveBeenCalled()
  })

  it("maps the service's typed 409 conflict", async () => {
    mocks.message.mockRejectedValueOnce(new mocks.MockAgentCommandError("active_turn_changed", "stale", 409, { actualTurnId: "turn_2" }))
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "client_stale", expectedTurnId: "turn_1", content: [{ type: "text", text: "Steer" }] }) as never, params)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "active_turn_changed", details: { actualTurnId: "turn_2" } } })
  })

  it("maps an active-Turn selected-job conflict to 409", async () => {
    mocks.message.mockRejectedValueOnce(new mocks.MockAgentCommandError("selected_job_turn_active", "Stop or finish the active Turn", 409, { turnId: "turn_1" }))
    const { POST } = await import("./route")
    const response = await POST(request({
      clientMessageId: "prepare_active",
      delivery: "follow_up",
      selectedJobPreparation: { jobId: "job_1" },
      content: [{ type: "text", text: "Prepare a cover letter draft for the selected job." }],
    }) as never, params)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "selected_job_turn_active", details: { turnId: "turn_1" } } })
  })

  it("maps a parked Turn to a safe dedicated-action 409", async () => {
    mocks.message.mockRejectedValueOnce(new mocks.MockAgentCommandError(
      "turn_wait_requires_dedicated_action",
      "This Turn is waiting for a required user or approval action",
      409,
      { turnId: "turn_1", status: "waiting_for_approval" },
    ))
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "client_parked", expectedTurnId: "turn_1", content: [{ type: "text", text: "Proceed" }] }) as never, params)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "turn_wait_requires_dedicated_action",
        message: "This Turn is waiting for a required user or approval action",
        details: { turnId: "turn_1", status: "waiting_for_approval" },
      },
    })
  })

  it("rejects forbidden userId and tool payloads before calling the service", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "client_unsafe", userId: "other", tool: { name: "submit_application" }, content: [{ type: "text", text: "send" }] }) as never, params)

    expect(response.status).toBe(422)
    expect(mocks.message).not.toHaveBeenCalled()
  })

  it("rejects an attachment that is not owned by the authenticated user", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "client_file", content: [{ type: "attachment_ref", attachmentId: "resume_other", mediaType: "application/pdf" }] }) as never, params)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "attachment_not_owned" } })
    expect(mocks.resumeFindMany).toHaveBeenCalledWith({ where: { id: { in: ["resume_other"] }, userId: "user_1" }, select: { id: true } })
    expect(mocks.message).not.toHaveBeenCalled()
  })

  it("returns auth errors without reading or dispatching the command", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const { POST } = await import("./route")
    const response = await POST(request({ clientMessageId: "client_auth", content: [{ type: "text", text: "Find jobs" }] }) as never, params)

    expect(response.status).toBe(401)
    expect(mocks.message).not.toHaveBeenCalled()
  })
})
