import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  featureAllowed: vi.fn(),
  featureEnabled: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionCreate: vi.fn(),
  agentConfigFindUnique: vi.fn(),
  turnFindFirst: vi.fn(),
  inputFindFirst: vi.fn(),
  start: vi.fn(),
}))

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.auth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock("@/lib/entitlements", () => ({ isFeatureAllowed: mocks.featureAllowed }))
vi.mock("@/lib/runtime-feature-flags", () => ({
  isRuntimeAgentHarnessFeatureEnabled: mocks.featureEnabled,
}))
vi.mock("@/lib/db", () => ({
  db: {
    agentSession: { findFirst: mocks.sessionFindFirst, create: mocks.sessionCreate },
    agentConfig: { findUnique: mocks.agentConfigFindUnique },
    agentTurn: { findFirst: mocks.turnFindFirst },
    agentInput: { findFirst: mocks.inputFindFirst },
  },
}))
vi.mock("@/lib/agent/control-plane/commands", () => ({
  AgentCommandError: class AgentCommandError extends Error {},
  AgentCommandService: class { start = mocks.start },
}))

import { POST } from "./route"

function request(body: unknown) {
  return new Request("http://localhost/api/agent/discovery/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/agent/discovery/start", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ userId: "user_1" })
    mocks.featureAllowed.mockResolvedValue(true)
    mocks.featureEnabled.mockResolvedValue(false)
    mocks.sessionFindFirst.mockResolvedValue(null)
    mocks.sessionCreate.mockResolvedValue({ id: "discovery_session" })
    mocks.agentConfigFindUnique.mockResolvedValue({ targetRoles: ["Platform Engineer"], targetLocations: ["Dublin"] })
    mocks.turnFindFirst.mockResolvedValue(null)
    mocks.inputFindFirst.mockResolvedValue(null)
    mocks.start.mockResolvedValue({ inputId: "input_1", turnId: "turn_1", disposition: "started", sequence: "1" })
  })

  it("reports discovery unavailable while the server-managed default-off gate is disabled", async () => {
    const response = await POST(request({ clientMessageId: "request_1" }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ mode: "unavailable", reason: "feature_disabled" })
    expect(mocks.featureEnabled).toHaveBeenCalledWith("AGENT_INTERACTIVE_DISCOVERY_TASK_GRAPH", "user_1")
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("rejects browser-supplied mode and intent fields without enabling the server gate", async () => {
    const response = await POST(request({
      clientMessageId: "request_2",
      enabled: true,
      intent: { kind: "interactive_discovery_shortlist", version: 1 },
    }) as never)

    expect(response.status).toBe(422)
    expect(mocks.featureEnabled).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("creates a canonical session and starts with the trusted intent when the server gate is enabled", async () => {
    mocks.featureEnabled.mockResolvedValue(true)

    const response = await POST(request({ clientMessageId: "request_3" }) as never)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      mode: "task_graph",
      sessionId: "discovery_session",
      inputId: "input_1",
      turnId: "turn_1",
      disposition: "started",
      sequence: "1",
    })
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user_1", goal: expect.any(String), source: "chat", status: "running" }),
      select: { id: true },
    })
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "discovery_session",
      userId: "user_1",
      clientMessageId: "request_3",
      source: "user",
      intent: { kind: "interactive_discovery_shortlist", version: 1 },
      content: [{
        type: "text",
        text: expect.stringContaining('"targetRoles":["Platform Engineer"],"targetLocations":["Dublin"]'),
      }],
    }))
    expect(mocks.agentConfigFindUnique).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      select: { targetRoles: true, targetLocations: true },
    })
    expect(mocks.featureAllowed).toHaveBeenCalledWith("user_1", "job_discovery")
  })

  it("denies opted-in discovery when the caller lacks the job-discovery entitlement", async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.featureAllowed.mockResolvedValue(false)

    const response = await POST(request({ clientMessageId: "request_no_discovery" }) as never)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ mode: "unavailable", reason: "not_entitled" })
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("uses the saved inventory without inventing filters when no target preferences exist", async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.agentConfigFindUnique.mockResolvedValue(null)

    const response = await POST(request({ clientMessageId: "request_no_preferences" }) as never)

    expect(response.status).toBe(202)
    const command = mocks.start.mock.calls[0]?.[0]
    const goal = command?.content[0]?.text
    expect(goal).toContain('"targetRoles":[],"targetLocations":[]')
    expect(goal).toContain("No target roles or locations are configured; do not invent them. Search the saved job inventory without target filters.")
  })

  it("returns the existing canonical command on an idempotent retry", async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.inputFindFirst.mockResolvedValue({
      id: "input_existing",
      sessionId: "session_existing",
      targetTurnId: "turn_existing",
      acceptedSequence: 7,
      session: { goal: "Discover and shortlist relevant jobs from my saved job inventory, using target roles and locations when configured.", source: "chat" },
      targetTurn: { input: { intent: { kind: "interactive_discovery_shortlist", version: 1 } } },
    })

    const response = await POST(request({ clientMessageId: "request_retry" }) as never)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      mode: "task_graph",
      sessionId: "session_existing",
      turnId: "turn_existing",
      inputId: "input_existing",
      disposition: "duplicate",
      sequence: "7",
    })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("returns the existing canonical command after the server gate is rolled back", async () => {
    mocks.featureAllowed.mockResolvedValue(false)
    mocks.inputFindFirst.mockResolvedValue({
      id: "input_existing",
      sessionId: "session_existing",
      targetTurnId: "turn_existing",
      acceptedSequence: 7,
      session: { goal: "Discover and shortlist relevant jobs from my saved job inventory, using target roles and locations when configured.", source: "chat" },
      targetTurn: { input: { intent: { kind: "interactive_discovery_shortlist", version: 1 } } },
    })

    const response = await POST(request({ clientMessageId: "request_rollback_retry" }) as never)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      mode: "task_graph",
      sessionId: "session_existing",
      turnId: "turn_existing",
      inputId: "input_existing",
      disposition: "duplicate",
      sequence: "7",
    })
    expect(mocks.featureAllowed).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("does not reuse an idempotency key from an ordinary Agent command", async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.inputFindFirst.mockResolvedValue({
      id: "input_ordinary",
      sessionId: "session_chat",
      targetTurnId: "turn_chat",
      acceptedSequence: 4,
      session: { goal: "A normal conversation", source: "chat" },
      targetTurn: { input: { goal: "A normal message" } },
    })

    const response = await POST(request({ clientMessageId: "request_chat_collision" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("rejects a mismatched reused key before returning unavailable after rollback", async () => {
    mocks.featureAllowed.mockResolvedValue(false)
    mocks.inputFindFirst.mockResolvedValue({
      id: "input_ordinary",
      sessionId: "session_chat",
      targetTurnId: "turn_chat",
      acceptedSequence: 4,
      session: { goal: "A normal conversation", source: "chat" },
      targetTurn: { input: { goal: "A normal message" } },
    })

    const response = await POST(request({ clientMessageId: "request_chat_collision_after_rollback" }) as never)

    expect(response.status).toBe(409)
    expect(mocks.featureAllowed).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })
})
