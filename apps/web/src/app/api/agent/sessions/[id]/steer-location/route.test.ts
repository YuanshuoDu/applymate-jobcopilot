import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

const mocks = vi.hoisted(() => {
  class MockAgentCommandError extends Error {
    constructor(readonly code: string, message: string, readonly status: number, readonly details: Record<string, unknown> = {}) {
      super(message)
    }
  }
  return { requireAuth: vi.fn(), accept: vi.fn(), MockAgentCommandError }
})

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/agent/control-plane/commands", () => ({ AgentCommandError: mocks.MockAgentCommandError }))
vi.mock("@/lib/agent/control-plane/commands/objective-location-steer", () => ({
  acceptObjectiveLocationSteer: mocks.accept,
}))

const params = { params: Promise.resolve({ id: "session_1" }) }

function body(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
    clientMessageId: "steer_1",
    expectedTurnId: "turn_1",
    expectedRevision: 7,
    locations: ["Dublin", " Berlin "],
    ...overrides,
  }
}

function request(value: unknown, key: string | null = "steer_1") {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (key !== null) headers["idempotency-key"] = key
  return new Request("http://localhost/api/agent/sessions/session_1/steer-location", {
    method: "POST", headers, body: JSON.stringify(value),
  })
}

function rawRequest(raw: string) {
  return new Request("http://localhost/api/agent/sessions/session_1/steer-location", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "steer_1" }, body: raw,
  })
}

describe("steer-location command API", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED", "1")
    mocks.requireAuth.mockReset()
    mocks.accept.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: "user_1" })
    mocks.accept.mockResolvedValue({ inputId: "input_1", turnId: "turn_1", disposition: "steered", sequence: "9" })
  })

  afterEach(() => vi.unstubAllEnvs())

  it("dispatches only the exact authenticated typed request and returns 202", async () => {
    const { POST } = await import("./route")
    const response = await POST(request(body()) as never, params)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ disposition: "steered", sequence: "9" })
    expect(mocks.accept).toHaveBeenCalledWith(expect.any(Object), {
      ...body(), userId: "user_1", sessionId: "session_1",
    })
  })

  it("rejects disabled location steering before calling the command service", async () => {
    vi.stubEnv("AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED", "0")
    const { POST } = await import("./route")
    const response = await POST(request(body()) as never, params)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "objective_location_verification_unavailable" } })
    expect(mocks.accept).not.toHaveBeenCalled()
  })

  it("rejects spoofed authority fields, unknown fields, and mismatched idempotency keys", async () => {
    const { POST } = await import("./route")
    const invalidRequests = [
      [body({ userId: "other" }), "steer_1"],
      [body({ sessionId: "other" }), "steer_1"],
      [body({ source: "automation" }), "steer_1"],
      [body({ approval: { approved: true } }), "steer_1"],
      [body({ unexpected: true }), "steer_1"],
      [body({ clientMessageId: "body_id" }), "steer_1"],
      [body(), "different"],
      [body(), null],
      [body({ expectedRevision: 1.5 }), "steer_1"],
    ] as const

    for (const [value, key] of invalidRequests) {
      expect((await POST(request(value, key) as never, params)).status).toBe(422)
    }
    expect(mocks.accept).not.toHaveBeenCalled()
  })

  it("maps typed command errors and rejects unauthenticated requests", async () => {
    const { POST } = await import("./route")
    mocks.accept.mockRejectedValueOnce(new mocks.MockAgentCommandError(
      "active_turn_changed", "The active Agent Turn changed before this command was accepted", 409, { expectedRevision: 7 },
    ))
    const conflict = await POST(request(body()) as never, params)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "active_turn_changed" } })

    mocks.accept.mockClear()
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }))
    const unauthorized = await POST(request(body()) as never, params)
    expect(unauthorized.status).toBe(401)
    expect(mocks.accept).not.toHaveBeenCalled()
  })

  it("keeps the existing bounded raw-body reader", async () => {
    const { POST } = await import("./route")
    const response = await POST(rawRequest(`{"padding":"${"x".repeat(256 * 1024)}"}`) as never, params)

    expect(response.status).toBe(422)
    expect(mocks.accept).not.toHaveBeenCalled()
  })
})
