import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(() => ({ connect: mocks.connect, end: mocks.end })),
  },
}));

import { closeSharedPool, loadWorkerAiConfig } from "./llm.js";

describe("worker platform AI routing", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.connect.mockReset().mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.release.mockReset();
    mocks.end.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-platform-key");
  });

  afterEach(() => {
    closeSharedPool();
    vi.unstubAllEnvs();
  });

  it("uses the configured fallback when the primary provider is disabled", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ preferences: null }] })
      .mockResolvedValueOnce({ rows: [{ defaultProvider: "openai", defaultModel: "gpt-managed", fallbackProvider: "deepseek", fallbackModel: "deepseek-managed" }] })
      .mockResolvedValueOnce({ rows: [{ apiBase: "https://openai.example/v1", secretRef: "OPENAI_API_KEY", enabled: false, active: true }] })
      .mockResolvedValueOnce({ rows: [{ apiBase: "https://deepseek.example/v1", secretRef: "DEEPSEEK_API_KEY", enabled: true, active: true }] });

    await expect(loadWorkerAiConfig("user-1")).resolves.toEqual({
      provider: "deepseek",
      model: "deepseek-managed",
      apiBase: "https://deepseek.example/v1",
      apiKey: "deepseek-platform-key",
    });
  });

  it("keeps a user auto-apply model ahead of the platform route", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ preferences: { aiSettings: { features: { autoApply: { provider: "openai", model: "gpt-user" }, }, keys: { openai: "user-key" } } } }] });

    await expect(loadWorkerAiConfig("user-1")).resolves.toMatchObject({ provider: "openai", model: "gpt-user", apiKey: "user-key" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
