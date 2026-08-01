import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  loadUserAiConfig: vi.fn(),
  runAgentPipeline: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { agentSession: { findFirst: mocks.findFirst } } }));
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
    mocks.loadUserAiConfig.mockResolvedValue({ provider: "minimax", model: "MiniMax-M3", resolvedKey: "platform-key" });
    mocks.runAgentPipeline.mockResolvedValue({ processed: 1, queued: 1, applied: 0, pending: 0, skipped: 0, failed: 0, durationMs: 10 });
  });

  it("rejects an unauthenticated worker request", async () => {
    const { POST } = await import("./route");
    const response = await POST(request() as never);

    expect(response.status).toBe(401);
    expect(mocks.runAgentPipeline).not.toHaveBeenCalled();
  });

  it("runs only the named automation session with the auto-apply model configuration", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ "x-agent-worker-secret": "worker-secret" }) as never);

    expect(response.status).toBe(200);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "session_1", userId: "user_1", source: "automation" }, select: { id: true },
    });
    expect(mocks.runAgentPipeline).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", sessionId: "session_1", autonomous: true,
    }));
    await expect(response.json()).resolves.toMatchObject({ status: "completed" });
  });
});
