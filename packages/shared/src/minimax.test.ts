import { describe, expect, it } from "vitest"

import {
  MINIMAX_CN_ANTHROPIC_BASE_URL,
  MINIMAX_CN_OPENAI_BASE_URL,
  MINIMAX_DEFAULT_ANTHROPIC_BASE_URL,
  MINIMAX_DEFAULT_BASE_URL,
  MINIMAX_INTERNATIONAL_ANTHROPIC_BASE_URL,
  MINIMAX_INTERNATIONAL_OPENAI_BASE_URL,
  inferMiniMaxRegionFromApiKey,
  miniMaxAnthropicBaseUrl,
  miniMaxOpenAiBaseUrl,
  parseMiniMaxRegion,
  resolveMiniMaxBaseUrl,
} from "./minimax.js"

describe("MiniMax regional endpoints", () => {
  it("exposes the documented OpenAI-compatible and Anthropic endpoints", () => {
    expect(MINIMAX_CN_OPENAI_BASE_URL).toBe("https://api.minimaxi.com/v1")
    expect(MINIMAX_CN_ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic")
    expect(MINIMAX_INTERNATIONAL_OPENAI_BASE_URL).toBe("https://api.minimax.io/v1")
    expect(MINIMAX_INTERNATIONAL_ANTHROPIC_BASE_URL).toBe("https://api.minimax.io/anthropic")
    expect(MINIMAX_DEFAULT_BASE_URL).toBe(MINIMAX_INTERNATIONAL_OPENAI_BASE_URL)
    expect(MINIMAX_DEFAULT_ANTHROPIC_BASE_URL).toBe(MINIMAX_INTERNATIONAL_ANTHROPIC_BASE_URL)
  })

  it.each([
    ["cn", "cn"],
    ["china", "cn"],
    ["international", "international"],
    ["global", "international"],
    ["invalid", undefined],
  ])("parses region %s", (input, expected) => {
    expect(parseMiniMaxRegion(input)).toBe(expected)
  })

  it.each([
    ["sk-cp-test-key", "cn"],
    [" SK-CP-test-key ", "cn"],
    ["sk-api-test-key", undefined],
    [undefined, undefined],
  ])("infers a region from Token Plan key %s", (input, expected) => {
    expect(inferMiniMaxRegionFromApiKey(input)).toBe(expected)
  })

  it("maps each supported region to both protocol endpoints", () => {
    expect(miniMaxOpenAiBaseUrl("cn")).toBe(MINIMAX_CN_OPENAI_BASE_URL)
    expect(miniMaxOpenAiBaseUrl("international")).toBe(MINIMAX_INTERNATIONAL_OPENAI_BASE_URL)
    expect(miniMaxAnthropicBaseUrl("cn")).toBe(MINIMAX_CN_ANTHROPIC_BASE_URL)
    expect(miniMaxAnthropicBaseUrl("international")).toBe(MINIMAX_INTERNATIONAL_ANTHROPIC_BASE_URL)
  })

  it("uses deployment overrides before stale persisted config", () => {
    expect(resolveMiniMaxBaseUrl({ apiBase: "https://api.minimax.io/v1", environmentRegion: "cn" }))
      .toBe(MINIMAX_CN_OPENAI_BASE_URL)
    expect(resolveMiniMaxBaseUrl({ environmentBaseUrl: "https://api.minimaxi.com/v1/", environmentRegion: "international" }))
      .toBe(MINIMAX_CN_OPENAI_BASE_URL)
  })

  it("keeps explicit international config and default behavior backward compatible", () => {
    expect(resolveMiniMaxBaseUrl({ apiBase: "https://api.minimax.io/v1/" })).toBe(MINIMAX_INTERNATIONAL_OPENAI_BASE_URL)
    expect(resolveMiniMaxBaseUrl()).toBe(MINIMAX_INTERNATIONAL_OPENAI_BASE_URL)
    expect(resolveMiniMaxBaseUrl({ region: "cn" })).toBe(MINIMAX_CN_OPENAI_BASE_URL)
  })

  it("routes a China Token Plan key away from a stale international default", () => {
    expect(resolveMiniMaxBaseUrl({ apiBase: MINIMAX_INTERNATIONAL_OPENAI_BASE_URL, apiKey: "sk-cp-test-key" }))
      .toBe(MINIMAX_CN_OPENAI_BASE_URL)
    expect(resolveMiniMaxBaseUrl({ apiKey: "sk-cp-test-key", baseUrl: "https://proxy.example/v1" }))
      .toBe("https://proxy.example/v1")
  })
})
