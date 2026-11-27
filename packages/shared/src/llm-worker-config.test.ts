import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  decryptSecret: vi.fn(),
  credentialContext: vi.fn((value: string) => value),
}));

vi.mock("pg", () => ({
  default: { Pool: vi.fn(() => ({ connect: mocks.connect, end: mocks.end })) },
}));

vi.mock("./secret-crypto.js", () => ({
  credentialContext: mocks.credentialContext,
  decryptSecret: mocks.decryptSecret,
}));

import { closeSharedPool, loadWorkerAgentAiRoute, loadWorkerAiConfig } from "./llm-worker-config.js";

function preferences(features: Record<string, unknown>, keys?: Record<string, string>) {
  return { aiSettings: { features, ...(keys ? { keys } : {}) } };
}

describe("Worker Agent AI route selection", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.connect.mockReset().mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.release.mockReset();
    mocks.end.mockReset().mockResolvedValue(undefined);
    mocks.decryptSecret.mockReset().mockImplementation(async (value: string) => `clear:${value}`);
    mocks.credentialContext.mockClear();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("MINIMAX_API_KEY", "");
  });

  afterEach(() => {
    closeSharedPool();
    vi.unstubAllEnvs();
  });

  it("selects the explicit Agent profile and feature credential over AutoApply", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: preferences({
      agent: { provider: "openai", model: "gpt-5.5", apiKey: "agent-cipher" },
      autoApply: { provider: "minimax", model: "MiniMax-M3", apiKey: "auto-cipher" },
    }, { openai: "provider-cipher" }) }] });

    await expect(loadWorkerAgentAiRoute("owner-1")).resolves.toMatchObject({
      source: "agent", config: { provider: "openai", model: "gpt-5.5", apiKey: "clear:agent-cipher", credentialSource: "user" },
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.decryptSecret).toHaveBeenCalledTimes(1);
    expect(mocks.decryptSecret).toHaveBeenCalledWith("agent-cipher", "ai:owner-1:feature:agent");
  });

  it("uses the owner's provider key before the same-provider platform key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "platform-test-key");
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: preferences({
      agent: { provider: "openai", model: "gpt-5.5" },
    }, { openai: "provider-cipher" }) }] });

    await expect(loadWorkerAgentAiRoute("owner-2")).resolves.toMatchObject({
      source: "agent", config: { provider: "openai", apiKey: "clear:provider-cipher", credentialSource: "user" },
    });
    expect(mocks.decryptSecret).toHaveBeenCalledWith("provider-cipher", "ai:owner-2:provider:openai");
  });

  it("allows a same-provider platform credential without changing the selected profile", async () => {
    vi.stubEnv("OPENAI_API_KEY", "platform-test-key");
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: preferences({
      agent: { provider: "openai", model: "gpt-5.5" },
      autoApply: { provider: "minimax", model: "MiniMax-M3" },
    }) }] });

    await expect(loadWorkerAgentAiRoute("owner-3")).resolves.toMatchObject({
      source: "agent", config: { provider: "openai", model: "gpt-5.5", apiKey: "platform-test-key", credentialSource: "platform" },
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("preserves the legacy Worker route for an absent or cleared Agent profile", async () => {
    const saved = preferences({
      agent: null,
      autoApply: { provider: "deepseek", model: "deepseek-v4-flash", apiKey: "auto-cipher" },
    }, { deepseek: "provider-cipher" });
    mocks.query.mockResolvedValue({ rows: [{ preferences: saved }] });

    const agentRoute = await loadWorkerAgentAiRoute("owner-4");
    const legacyRoute = await loadWorkerAiConfig("owner-4");

    expect(agentRoute.source).toBe("legacy");
    expect(agentRoute.config).toEqual(legacyRoute);
    expect(agentRoute.config).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash" });
  });

  it("keeps the existing AutoApply platform route when no Agent profile is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "platform-route-test-key");
    mocks.query
      .mockResolvedValueOnce({ rows: [{ preferences: null }] })
      .mockResolvedValueOnce({ rows: [{ defaultProvider: "openai", defaultModel: "gpt-managed" }] })
      .mockResolvedValueOnce({ rows: [{ apiBase: "https://openai.example/v1", secretRef: "OPENAI_API_KEY", enabled: true, active: true }] });

    await expect(loadWorkerAgentAiRoute("owner-4b")).resolves.toEqual({
      source: "legacy",
      config: { provider: "openai", model: "gpt-managed", apiBase: "https://openai.example/v1",
        apiKey: "platform-route-test-key", credentialSource: "platform" },
    });
    expect(mocks.query.mock.calls[1]?.[1]).toEqual(["autoApply"]);
  });

  it("holds the legacy pool client until both deferred platform route lookups finish", async () => {
    vi.stubEnv("OPENAI_API_KEY", "platform-route-test-key");
    type QueryResult = { rows: unknown[] };
    let resolveRoute!: (result: QueryResult) => void;
    let resolveProvider!: (result: QueryResult) => void;
    let routeStarted!: () => void;
    let providerStarted!: () => void;
    const routeResult = new Promise<QueryResult>(resolve => { resolveRoute = resolve; });
    const providerResult = new Promise<QueryResult>(resolve => { resolveProvider = resolve; });
    const routeQueryStarted = new Promise<void>(resolve => { routeStarted = resolve; });
    const providerQueryStarted = new Promise<void>(resolve => { providerStarted = resolve; });
    mocks.query
      .mockResolvedValueOnce({ rows: [{ preferences: null }] })
      .mockImplementationOnce(() => { routeStarted(); return routeResult; })
      .mockImplementationOnce(() => { providerStarted(); return providerResult; });

    const pending = loadWorkerAiConfig("legacy-owner");
    await routeQueryStarted;
    expect(mocks.release).not.toHaveBeenCalled();

    resolveRoute({ rows: [{ defaultProvider: "openai", defaultModel: "gpt-managed" }] });
    await providerQueryStarted;
    expect(mocks.release).not.toHaveBeenCalled();

    resolveProvider({ rows: [{ key: "openai", apiBase: "https://openai.example/v1", secretRef: "OPENAI_API_KEY", enabled: true, active: true }] });
    await expect(pending).resolves.toMatchObject({
      provider: "openai", model: "gpt-managed", apiBase: "https://openai.example/v1", apiKey: "platform-route-test-key",
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rejects a malformed Agent override without downgrading to AutoApply", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: preferences({
      agent: { provider: "openai" },
      autoApply: { provider: "minimax", model: "MiniMax-M3" },
    }) }] });

    await expect(loadWorkerAgentAiRoute("owner-5")).rejects.toThrow("Invalid AI Agent model configuration");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("does not decrypt unrelated settings on an explicit Agent route", async () => {
    mocks.decryptSecret.mockImplementation(async (value: string) => {
      if (value === "agent-cipher") return "clear:agent-cipher";
      throw new Error("unrelated credential was read");
    });
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: preferences({
      agent: { provider: "openai", model: "gpt-5.5", apiKey: "agent-cipher" },
      autoApply: { provider: "minimax", model: "MiniMax-M3", apiKey: "broken-auto-cipher" },
    }, { openai: "broken-provider-cipher", qwen: "unrelated-provider-cipher" }) }] });

    await expect(loadWorkerAgentAiRoute("owner-5b")).resolves.toMatchObject({
      source: "agent", config: { provider: "openai", apiKey: "clear:agent-cipher" },
    });
    expect(mocks.decryptSecret).toHaveBeenCalledTimes(1);
    expect(mocks.decryptSecret).toHaveBeenCalledWith("agent-cipher", "ai:owner-5b:feature:agent");
  });

  it("rejects a broken selected Agent credential without downgrading to AutoApply", async () => {
    mocks.decryptSecret.mockRejectedValueOnce(new Error("credential decryption failed"));
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: preferences({
      agent: { provider: "openai", model: "gpt-5.5", apiKey: "broken-agent-cipher" },
      autoApply: { provider: "minimax", model: "MiniMax-M3" },
    }) }] });

    await expect(loadWorkerAgentAiRoute("owner-5c")).rejects.toThrow("credential decryption failed");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.decryptSecret).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the explicit Agent provider has no credential even if AutoApply has one", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "legacy-platform-key");
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: preferences({
      agent: { provider: "openai", model: "gpt-5.5" },
      autoApply: { provider: "minimax", model: "MiniMax-M3" },
    }) }] });

    await expect(loadWorkerAgentAiRoute("owner-6")).rejects.toThrow("AI Agent model route has no authorized credential");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("preserves a configured custom endpoint", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: preferences({
      agent: { provider: "custom", model: "private-model", apiBase: "https://models.example/v1", apiKey: "agent-cipher" },
    }) }] });

    await expect(loadWorkerAgentAiRoute("owner-7")).resolves.toMatchObject({
      source: "agent", config: { provider: "custom", model: "private-model", apiBase: "https://models.example/v1", apiKey: "clear:agent-cipher" },
    });
  });
});
