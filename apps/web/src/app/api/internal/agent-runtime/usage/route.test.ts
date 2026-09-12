import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  admitAiUsage: vi.fn(), settleAiUsage: vi.fn(), resolveAiAccess: vi.fn(), loadWorkerAiConfig: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/entitlements", () => ({ resolveAiAccess: mocks.resolveAiAccess }))
vi.mock("@/lib/agent/control-plane/usage-broker", () => ({
  admitAiUsage: mocks.admitAiUsage, settleAiUsage: mocks.settleAiUsage, UsageBrokerError: class UsageBrokerError extends Error {},
}))
vi.mock("@jobcopilot/shared/llm", () => ({ loadWorkerAiConfig: mocks.loadWorkerAiConfig }))

const admission = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", leaseOwnerId: "worker-1", leaseVersion: 3,
  featureKey: "agent", provider: "minimax", model: "MiniMax-M3", attemptId: "attempt-1",
}

describe("internal agent runtime usage route", () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    vi.stubEnv("AGENT_WORKER_SECRET", "secret")
    mocks.resolveAiAccess.mockResolvedValue("allowed")
    mocks.loadWorkerAiConfig.mockResolvedValue({ provider: "minimax", model: "MiniMax-M3" })
    mocks.admitAiUsage.mockResolvedValue({ operationId: "agent-usage-1" })
  })

  it("authenticates the Worker, checks the trusted model, and returns the ledger identity", async () => {
    const { POST } = await import("./route")
    const response = await POST(new Request("http://localhost/api/internal/agent-runtime/usage", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ operation: "authorize", input: admission }),
    }) as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "authorized", operationId: "agent-usage-1" })
    expect(mocks.admitAiUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ...admission, credentialSource: "platform" }))
  })

  it("fails closed for missing secret, exhausted credits, or an untrusted model", async () => {
    const { POST } = await import("./route")
    const request = (headers: Record<string, string>, body = { operation: "authorize", input: admission }) => new Request("http://localhost", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }) as never
    expect((await POST(request({}))).status).toBe(401)
    mocks.resolveAiAccess.mockResolvedValue("exhausted")
    expect((await POST(request({ "x-agent-worker-secret": "secret" }))).status).toBe(429)
    mocks.resolveAiAccess.mockResolvedValue("allowed")
    mocks.loadWorkerAiConfig.mockResolvedValue({ provider: "openai", model: "gpt-5.5" })
    expect((await POST(request({ "x-agent-worker-secret": "secret" }))).status).toBe(403)
    expect(mocks.admitAiUsage).not.toHaveBeenCalled()
  })

  it("accepts a child Task owner envelope and rejects mixed owner identity", async () => {
    const { leaseOwnerId: _leaseOwnerId, leaseVersion: _leaseVersion, ...common } = admission
    const child = {
      ...common,
      executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "child-worker", attemptCount: 2 },
    }
    const { POST } = await import("./route")
    const request = (input: unknown) => new Request("http://localhost", { method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" }, body: JSON.stringify({ operation: "authorize", input }) }) as never
    expect((await POST(request(child))).status).toBe(200)
    expect(mocks.admitAiUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ executionOwner: child.executionOwner }))
    expect((await POST(request({ ...admission, executionOwner: child.executionOwner }))).status).toBe(400)
  })

  it("settles through the same authenticated endpoint without rechecking model configuration", async () => {
    const { POST } = await import("./route")
    const response = await POST(new Request("http://localhost", {
      method: "POST", headers: { "x-agent-worker-secret": "secret", "content-type": "application/json" },
      body: JSON.stringify({ operation: "settle", input: { operationId: "agent-usage-1", userId: "user-1", provider: "minimax", model: "MiniMax-M3", status: "error", inputTokens: 2, outputTokens: 0, estimatedCostUsd: 0, errorCode: "provider_error" } }),
    }) as never)
    expect(response.status).toBe(200)
    expect(mocks.settleAiUsage).toHaveBeenCalledOnce()
    expect(mocks.loadWorkerAiConfig).not.toHaveBeenCalled()
  })
})
