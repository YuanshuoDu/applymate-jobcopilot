import { describe, expect, it } from "vitest"

import { createAnthropicAdapter } from "../adapters/anthropic/index.js"
import { createMiniMaxM3Adapter } from "../adapters/minimax/index.js"
import { createOpenAiCompatibleAdapter } from "../adapters/openai-compatible/index.js"

describe("three-provider normalized contract matrix", () => {
  it("publishes the same required profile surface without making a live request", () => {
    const adapters = [
      createOpenAiCompatibleAdapter({
        provider: "openai-compatible", model: "gpt-test", baseUrl: "https://api.example.com/v1", apiKey: "test-key",
      }),
      createAnthropicAdapter({ provider: "anthropic", model: "claude-test", apiKey: "test-key" }),
      createMiniMaxM3Adapter({ platformApiKey: "test-key" }),
    ]
    for (const adapter of adapters) {
      expect(adapter.stream).toBeTypeOf("function")
      expect(adapter.profile).toMatchObject({
        provider: expect.any(String), model: expect.any(String),
        nativeTools: expect.any(Boolean), structuredOutput: expect.any(Boolean), streaming: true,
        continuationCursor: expect.any(Boolean), supportsParallelTools: expect.any(Boolean),
        supportsStreamingToolArgs: expect.any(Boolean), supportsReasoningSummary: expect.any(Boolean),
        supportsResponseContinuation: expect.any(Boolean), supportsProviderConversation: expect.any(Boolean),
        supportsBackgroundResponse: expect.any(Boolean), costClass: expect.any(String),
      })
    }
    expect(adapters.map(adapter => adapter.profile.provider)).toEqual([
      "openai-compatible", "anthropic", "minimax",
    ])
  })
})
