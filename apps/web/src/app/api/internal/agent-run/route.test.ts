import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  executionFindFirst: vi.fn(),
  loadUserAiConfig: vi.fn(),
  runAgentPipeline: vi.fn(),
  hasEffectiveEntitlement: vi.fn(),
  isFeatureAllowed: vi.fn(),
  resolveAiAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { agentSession: { findFirst: mocks.findFirst }, agentExecution: { findFirst: mocks.executionFindFirst } } }));
vi.mock("@/lib/api-helpers", () => ({
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}));
vi.mock("@/lib/model-router", () => ({
  APPLYMATE_BACKING: { provider: "minimax", model: "MiniMax-M3" },
  loadUserAiConfig: mocks.loadUserAiConfig,
  resolveConfig: vi.fn(value => ({ ...value, resolvedKey: "platform-key" })),
}));
vi.mock("@/lib/agent/run-service", () => ({ runAgentPipeline: mocks.runAgentPipeline }));
vi.mock("@/lib/entitlements", () => ({ hasEffectiveEntitlement: mocks.hasEffectiveEntitlement, isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess }));

function request(headers?: HeadersInit, body: unknown = { userId: "user_1", sessionId: "session_1" }) {
  return new Request("http://localhost/api/internal/agent-run", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

describe("POST /api/internal/agent-run", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(mocks).forEach(mock => mock.mockReset());
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret");
    mocks.findFirst.mockResolvedValue({ id: "session_1" });
    mocks.executionFindFirst.mockResolvedValue({ state: { autonomous: true } });
    mocks.loadUserAiConfig.mockResolvedValue({ provider: "minimax", model: "MiniMax-M3", resolvedKey: "platform-key" });
    mocks.runAgentPipeline.mockResolvedValue({ processed: 1, queued: 1, applied: 0, pending: 0, skipped: 0, failed: 0, durationMs: 10 });
    mocks.hasEffectiveEntitlement.mockResolvedValue(true);
    mocks.isFeatureAllowed.mockResolvedValue(true);
    mocks.resolveAiAccess.mockResolvedValue('allowed');
  });

  it("rejects an unauthenticated worker request", async () => {
    const { POST } = await import("./route");
    const response = await POST(request() as never);

    expect(response.status).toBe(401);
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled();
  });

  it("runs the named owned session with the auto-apply model configuration", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ "x-agent-worker-secret": "worker-secret" }) as never);

    expect(response.status).toBe(200);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1" }, select: { id: true },
    });
    expect(mocks.runAgentPipeline).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", sessionId: "session_1", autonomous: true,
    }));
    await expect(response.json()).resolves.toMatchObject({ status: "completed" });
  });

  it("blocks the worker when the current plan does not include auto-apply", async () => {
    mocks.isFeatureAllowed.mockResolvedValueOnce(false);
    const { POST } = await import("./route");

    const response = await POST(request({ "x-agent-worker-secret": "worker-secret" }) as never);

    expect(response.status).toBe(403);
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled();
  });

  it("blocks the worker when the monthly AI credits are exhausted", async () => {
    mocks.resolveAiAccess.mockResolvedValueOnce('exhausted');
    const { POST } = await import("./route");

    const response = await POST(request({ "x-agent-worker-secret": "worker-secret" }) as never);

    expect(response.status).toBe(429);
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled();
  });
});
