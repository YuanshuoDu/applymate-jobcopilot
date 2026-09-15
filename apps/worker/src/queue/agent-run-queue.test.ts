import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((job: { data: unknown }) => Promise<unknown>),
  canonical: vi.fn(),
  producer: { enqueue: vi.fn(), close: vi.fn() },
  createProducer: vi.fn(),
  workerClose: vi.fn(),
  queueCloses: [] as Array<ReturnType<typeof vi.fn>>,
}));
const pinnedFetch = vi.hoisted(() => vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)));

vi.mock("@jobcopilot/shared", async () => {
  const actual = await vi.importActual<typeof import("@jobcopilot/shared")>("@jobcopilot/shared");
  return { ...actual, pinnedFetch };
});

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.queueCloses.push(close);
    return { add: vi.fn(), close };
  }),
  Worker: vi.fn().mockImplementation((_name, handler) => {
    mocks.handler = handler;
    return { close: mocks.workerClose };
  }),
}));
vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }));
vi.mock("./agent-run-turn-executor.js", () => ({ runCanonicalAgentTurn: mocks.canonical }));
vi.mock("./agent-run-canonical-dispatch.js", () => ({ createAgentRunCanonicalProducer: mocks.createProducer }));

describe("agent-run queue", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.handler = undefined;
    mocks.canonical.mockReset();
    mocks.producer.enqueue.mockReset();
    mocks.producer.close.mockReset();
    mocks.createProducer.mockReset().mockReturnValue(mocks.producer);
    mocks.workerClose.mockReset().mockResolvedValue(undefined);
    mocks.queueCloses.length = 0;
    vi.stubEnv("AGENT_WEB_URL", "https://app.applymate.test/");
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret");
    vi.stubEnv("ENABLE_AGENT_COGNITIVE_LOOP", "0");
    vi.stubEnv("ENABLE_AGENT_CANONICAL_AUTOMATION", "0");
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

  it("uses the existing pipeline adapter as an explicit gate-off rollback", async () => {
    mocks.canonical.mockResolvedValue({ status: "completed", summary: "pipeline complete" });
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "execution_1" } }))
      .resolves.toEqual({ status: "completed", summary: "pipeline complete" });
    expect(mocks.canonical).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ turnId: "turn_1", executionId: "execution_1" }) }),
      expect.anything(),
    );
    expect(mocks.producer.enqueue).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes a Turn-bound task to agent-turns when the exact server gate is enabled", async () => {
    vi.stubEnv("ENABLE_AGENT_CANONICAL_AUTOMATION", "1");
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1", executionId: "untrusted" } }))
      .resolves.toEqual({ status: "routed", queue: "agent-turns", turnId: "turn_1" });
    expect(mocks.producer.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.producer.enqueue).toHaveBeenCalledWith({ sessionId: "session_1", turnId: "turn_1" });
    expect(mocks.producer.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("executionId");
    expect(mocks.canonical).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes a Turn-bound task when the complete cognitive loop gate is enabled", async () => {
    vi.stubEnv("ENABLE_AGENT_COGNITIVE_LOOP", "1");
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1" } }))
      .resolves.toEqual({ status: "routed", queue: "agent-turns", turnId: "turn_1" });
    expect(mocks.producer.enqueue).toHaveBeenCalledWith({ sessionId: "session_1", turnId: "turn_1" });
    expect(mocks.canonical).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates canonical enqueue failures for BullMQ retry", async () => {
    vi.stubEnv("ENABLE_AGENT_CANONICAL_AUTOMATION", "1");
    mocks.producer.enqueue.mockRejectedValue(new Error("outbox unavailable"));
    await import("./agent-run-queue.js");

    await expect(mocks.handler?.({ data: { userId: "user_1", sessionId: "session_1", turnId: "turn_1" } }))
      .rejects.toThrow("outbox unavailable");
    expect(mocks.canonical).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes the canonical producer and legacy resources during shutdown", async () => {
    await import("./agent-run-queue.js");
    const { closeAgentRunResources } = await import("./agent-run-queue.js");

    await closeAgentRunResources();

    expect(mocks.workerClose).toHaveBeenCalledTimes(1);
    expect(mocks.producer.close).toHaveBeenCalledTimes(1);
    expect(mocks.queueCloses).toHaveLength(1);
    expect(mocks.queueCloses.every(close => close.mock.calls.length === 1)).toBe(true);
  });
});
