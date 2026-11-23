import { beforeEach, describe, expect, it, vi } from "vitest"
import { VERIFIED_SHORTLIST_SELECTION_SCHEMA } from "@jobcopilot/agent-protocol"
import { canonicalTaskGraphItemId } from "@/lib/agent/session/final-task-graph-source-detail"

const mocks = vi.hoisted(() => {
  class MockAgentCommandError extends Error {
    constructor(readonly code: string, message: string, readonly status: number, readonly details: Record<string, unknown> = {}) {
      super(message)
    }
  }
  return { requireAuth: vi.fn(), start: vi.fn(), MockAgentCommandError }
})

vi.mock("@/lib/api-helpers", () => ({
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {} }))

vi.mock("@/lib/agent/control-plane/commands", () => ({ AgentCommandError: mocks.MockAgentCommandError }))

vi.mock("@/lib/agent/control-plane/commands/errors", () => ({
  invalidCommand: (message: string) => new mocks.MockAgentCommandError("invalid_command", message, 422),
}))

vi.mock("@/lib/agent/control-plane/commands/selected-job-batch-command", () => ({
  SelectedJobBatchCommandService: class { start = mocks.start },
}))

const sessionId = "session_1"
const source = {
  sessionId,
  sourceTurnId: "discovery_turn_1",
  rootTaskId: "root_1",
  graphItemId: canonicalTaskGraphItemId("root_1"),
  graphRevision: 3,
}
const context = { params: Promise.resolve({ id: sessionId }) }

function body(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA,
    clientMessageId: "batch_1",
    source,
    selectedJobIds: ["job_1", "job_2"],
    ...overrides,
  }
}

function request(value: unknown, key = "batch_1") {
  return new Request(`http://localhost/api/agent/sessions/${sessionId}/prepare-selected-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(value),
  })
}

function rawRequest(raw: string) {
  return new Request(`http://localhost/api/agent/sessions/${sessionId}/prepare-selected-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "batch_1" },
    body: raw,
  })
}

describe("prepare-selected-jobs command API", () => {
  beforeEach(() => {
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: "user_1" })
    mocks.start.mockReset().mockResolvedValue({ inputId: "input_1", turnId: "turn_1", disposition: "started", sequence: "8" })
  })

  it("maps the exact authenticated payload to the user-owned batch command", async () => {
    const { POST } = await import("./route")
    const response = await POST(request(body()) as never, context)

    expect(response.status).toBe(202)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    await expect(response.json()).resolves.toMatchObject({ turnId: "turn_1", disposition: "started" })
    expect(mocks.start).toHaveBeenCalledWith({
      sessionId,
      userId: "user_1",
      clientMessageId: "batch_1",
      source: "user",
      sourceIdentity: source,
      selectedJobIds: ["job_1", "job_2"],
    })
  })

  it("rejects malformed or widened payloads and mismatched idempotency before dispatch", async () => {
    const { POST } = await import("./route")
    const widened = await POST(request(body({ userId: "user_2" })) as never, context)
    expect(widened.status).toBe(422)
    await expect(widened.json()).resolves.toMatchObject({ error: { code: "invalid_command" } })

    const invalid = [
      body({ intent: { kind: "selected_job_batch_preparation", version: 1 } }),
      body({ extra: true }),
      body({ schemaVersion: "agent-harness.v2.unknown.v1" }),
      body({ source: { ...source, sessionId: "other_session" } }),
      body({ selectedJobIds: ["job_1", "job_1"] }),
      body({ selectedJobIds: ["job_1"] }),
    ]
    for (const value of invalid) {
      expect((await POST(request(value) as never, context)).status).toBe(422)
    }
    expect((await POST(request(body(), "different_key") as never, context)).status).toBe(422)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON without dispatching a command", async () => {
    const { POST } = await import("./route")
    const response = await POST(rawRequest("{") as never, context)

    expect(response.status).toBe(422)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("requires authentication before parsing or dispatch", async () => {
    const { POST } = await import("./route")
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const response = await POST(request(body()) as never, context)

    expect(response.status).toBe(401)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("preserves typed owner/source conflicts from the command service", async () => {
    const { POST } = await import("./route")
    mocks.start.mockRejectedValueOnce(new mocks.MockAgentCommandError(
      "invalid_command", "The verified shortlist or selected Jobs are no longer available", 422,
    ))
    const response = await POST(request(body()) as never, context)

    expect(response.status).toBe(422)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_command" } })
  })

  it("keeps exact idempotent replays on the accepted 202 command contract", async () => {
    const { POST } = await import("./route")
    mocks.start.mockResolvedValueOnce({ inputId: "input_1", turnId: "turn_1", disposition: "duplicate",
      originalDisposition: "started", sequence: "8" })
    const response = await POST(request(body()) as never, context)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ disposition: "duplicate", originalDisposition: "started" })
  })
})
