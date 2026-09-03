import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handler: undefined as undefined | ((job: { data: unknown }) => Promise<unknown>), canonical: vi.fn() }));
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)));

vi.mock("@jobcopilot/shared", async () => {
  const actual = await vi.importActual<typeof import("@jobcopilot/shared")>("@jobcopilot/shared");
  return { ...actual, pinnedFetch };
});

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation((_name, handler) => {
    mocks.handler = handler;
    return {};
  }),
}));
vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }));
vi.mock("./agent-run-turn-executor.js", () => ({ runCanonicalAgentTurn: mocks.canonical }));

describe("agent-run queue", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.handler = undefined;
    mocks.canonical.mockReset();
    vi.stubEnv("AGENT_WEB_URL", "https://app.applymate.test/");
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "completed" }))));
  });

  it("calls the authenticated internal pipeline endpoint for a scheduled session", async () => {
    await import("./agent-run-queue.js");
    await mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1" } });

    expect(fetch).toHaveBeenCalledWith("https://app.applymate.test/api/internal/agent-run", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-agent-worker-secret": "worker-secret" }),
      body: JSON.stringify({ userId: "user_1", sessionId: "session_1" }),
    }));
  }, 15_000);

  it("rejects a task when the worker URL is not configured", async () => {
    vi.stubEnv("AGENT_WEB_URL", "");
    await import("./agent-run-queue.js");
    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1" } })).rejects.toThrow("AGENT_WEB_URL");
  });

  it("does not retry a run rejected after account suspension or entitlement revocation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Account unavailable" }), { status: 403 })));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1" } })).resolves.toEqual({
      status: "skipped", reason: "authorization-revoked",
    });
  });

  it("dispatches the canonical TurnEngine adapter only for a Turn-bound task", async () => {
    mocks.canonical.mockResolvedValue({ status: "completed", summary: "pipeline complete" });
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" } }))
      .resolves.toEqual({ status: "completed", summary: "pipeline complete" });
    expect(mocks.canonical).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ turnId: "turn_1", executionId: "execution_1" }) }), expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });
});
