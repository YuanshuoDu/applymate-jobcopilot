import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(), sessionFindFirst: vi.fn(), executionFindFirst: vi.fn(), runAgentPipeline: vi.fn(),
  isFeatureAllowed: vi.fn(), resolveAiAccess: vi.fn(), hasEffectiveEntitlement: vi.fn(), loadUserAiConfig: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.userFindUnique }, agentSession: { findFirst: mocks.sessionFindFirst }, agentExecution: { findFirst: mocks.executionFindFirst } } }))
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
    mocks.executionFindFirst.mockResolvedValue({ state: { autonomous: true } })
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
    expect(mocks.runAgentPipeline).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1", autonomous: true, source: "automation" }))
  })
})
