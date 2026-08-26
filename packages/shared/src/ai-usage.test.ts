import { describe, expect, it, vi } from "vitest";
import { estimateSharedAiCost, recordSharedAiUsage, sharedAiUsageErrorCode } from "./ai-usage.js";

describe("shared AI usage", () => {
  it("uses the catalogue prices for every built-in model provider", () => {
    expect(estimateSharedAiCost({ provider: "anthropic", model: "claude-sonnet-5", credentialSource: "platform", inputTokens: 1_000_000, outputTokens: 1_000_000, latencyMs: 1, status: "success" })).toBe(18);
    expect(estimateSharedAiCost({ provider: "qwen", model: "qwen3.7-plus", credentialSource: "platform", inputTokens: 1_000_000, outputTokens: 1_000_000, latencyMs: 1, status: "success" })).toBe(1.4);
    expect(estimateSharedAiCost({ provider: "zhipu", model: "glm-5.1", credentialSource: "platform", inputTokens: 1_000_000, outputTokens: 1_000_000, latencyMs: 1, status: "success" })).toBe(4.55);
  });

  it("estimates known provider cost and stores only operational metadata", async () => {
    const query = vi.fn().mockResolvedValue({});
    const input = { userId: "user-1", provider: "minimax", model: "MiniMax-M3", credentialSource: "platform" as const, inputTokens: 1_000, outputTokens: 500, latencyMs: 80, status: "success" as const };
    expect(estimateSharedAiCost(input)).toBe(0.0018);
    await recordSharedAiUsage({ query }, input);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).not.toContain("prompt");
    expect(query.mock.calls[0][1]).toContain("platform");
  });

  it("classifies and strips provider response text before persistence", async () => {
    const query = vi.fn().mockResolvedValue({});
    const upstream = new Error("Anthropic API error 503: private provider response body");
    expect(sharedAiUsageErrorCode(upstream)).toBe("http_503");
    await recordSharedAiUsage({ query }, { provider: "anthropic", model: "claude-sonnet-5", credentialSource: "platform", latencyMs: 20, status: "error", errorCode: upstream.message });
    expect(query.mock.calls[0][1]).toContain("http_503");
    expect(JSON.stringify(query.mock.calls)).not.toContain("private provider response body");
  });
});
