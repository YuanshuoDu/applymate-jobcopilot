import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(), sessionFindFirst: vi.fn(), turnFindFirst: vi.fn(), executionFindFirst: vi.fn(), runAgentPipeline: vi.fn(),
  isFeatureAllowed: vi.fn(), resolveAiAccess: vi.fn(), hasEffectiveEntitlement: vi.fn(), loadUserAiConfig: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.userFindUnique }, agentSession: { findFirst: mocks.sessionFindFirst }, agentTurn: { findFirst: mocks.turnFindFirst }, agentExecution: { findFirst: mocks.executionFindFirst } } }))
vi.mock("@/lib/agent/run-service", () => ({ runAgentPipeline: mocks.runAgentPipeline }))
vi.mock("@/lib/entitlements", () => ({ isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess, hasEffectiveEntitlement: mocks.hasEffectiveEntitlement }))
vi.mock("@/lib/model-router", () => ({ APPLYMATE_BACKING: {}, loadUserAiConfig: mocks.loadUserAiConfig, resolveConfig: vi.fn(() => ({ provider: "minimax", model: "default", apiKey: "key" })) }))
vi.mock("@/lib/api-helpers", () => ({ ok: (value: unknown) => Response.json(value), err: (message: string, status: number) => Response.json({ error: message }, { status }) }))

describe("internal agent-run compatibility route", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    vi.stubEnv("AGENT_WORKER_SECRET", "secret")
    mocks.userFindUnique.mockResolvedValue({ accountStatus: "active" })
    mocks.sessionFindFirst.mockResolvedValue({ id: "session_1" })
    mocks.turnFindFirst.mockResolvedValue({ id: "turn_1", userId: "user_1", sessionId: "session_1", status: "in_progress" })
    mocks.executionFindFirst.mockResolvedValue({ id: "execution_1", userId: "user_1", sessionId: "session_1", state: { autonomous: true } })
    mocks.isFeatureAllowed.mockResolvedValue(true)
    mocks.resolveAiAccess.mockResolvedValue("enabled")
    mocks.hasEffectiveEntitlement.mockResolvedValue(true)
    mocks.loadUserAiConfig.mockResolvedValue({ resolvedKey: { provider: "minimax", model: "test", apiKey: "key" } })
    mocks.runAgentPipeline.mockResolvedValue({ processed: 1, failed: 0 })
  })

  it("passes canonical Turn and execution identity to the legacy-compatible handler", async () => {
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(200)
    expect(mocks.turnFindFirst).toHaveBeenCalledWith({
      where: { id: "turn_1", sessionId: "session_1", userId: "user_1" },
      select: { id: true, status: true, userId: true, sessionId: true },
    })
    expect(mocks.executionFindFirst).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", sessionId: "session_1" },
      select: { id: true, state: true, userId: true, sessionId: true },
    })
    expect(mocks.runAgentPipeline).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1", autonomous: true, source: "automation" }))
  })

  it("rejects a canonical request when the session is not owned by the user", async () => {
    mocks.sessionFindFirst.mockResolvedValueOnce(null)
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "forged_user", sessionId: "session_1", turnId: "turn_1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_identity_mismatch" } })
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("rejects a canonical request when the Turn is not owned by the identity", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce({ id: "turn_1", userId: "other_user", sessionId: "other_session", status: "in_progress" })
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", turnId: "forged_turn" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_turn_not_owned" } })
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("rejects a canonical request when the Turn is terminal", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce({ id: "turn_1", userId: "user_1", sessionId: "session_1", status: "completed" })
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", turnId: "turn_1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_turn_not_active" } })
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("rejects a canonical request when the execution is not owned by the identity", async () => {
    mocks.executionFindFirst.mockResolvedValueOnce({ id: "execution_1", userId: "other_user", sessionId: "other_session", state: { autonomous: true } })
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "forged_execution" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_execution_not_owned" } })
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })

  it("rejects a canonical request with missing identity before touching the pipeline", async () => {
    const { POST } = await import("./route")
    const request = new Request("http://localhost/api/internal/agent-run", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session_1", turnId: "turn_1" }),
    })

    const response = await POST(request as never)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "canonical_identity_required" } })
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled()
  })
})
