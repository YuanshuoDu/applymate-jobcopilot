import { afterEach, describe, expect, it, vi } from "vitest"

import { AgentModelError } from "../../errors.js"
import {
  buildMiniMaxRequestBody,
  miniMaxRequestOptions,
  resolveMiniMaxBaseUrl,
  resolveMiniMaxCredentials,
} from "./request.js"

afterEach(() => vi.unstubAllEnvs())

describe("MiniMax request profile", () => {
  it("resolves BYOK before the platform environment key", () => {
    vi.stubEnv("MINIMAX_API_KEY", "environment-key")
    expect(resolveMiniMaxCredentials({ apiKey: " user-key ", platformApiKey: "platform-key" })).toEqual({
      apiKey: "user-key", credentialSource: "user",
    })
    expect(resolveMiniMaxCredentials({ platformApiKey: " platform-key " })).toEqual({
      apiKey: "platform-key", credentialSource: "platform",
    })
    expect(resolveMiniMaxCredentials()).toEqual({ apiKey: "environment-key", credentialSource: "platform" })
  })

  it("resolves the CN endpoint from the deployment region", () => {
    vi.stubEnv("MINIMAX_REGION", "cn")
    expect(resolveMiniMaxBaseUrl({ apiBase: "https://api.minimax.io/v1" })).toBe("https://api.minimax.cn/v1")
  })

  it("allows an explicit deployment base URL and normalizes its trailing slash", () => {
    vi.stubEnv("MINIMAX_BASE_URL", "https://api.minimax.cn/v1/")
    vi.stubEnv("MINIMAX_REGION", "international")
    expect(resolveMiniMaxBaseUrl()).toBe("https://api.minimax.cn/v1")
  })

  it("replaces deprecated max_tokens and adds M3 reasoning controls", () => {
    const options = miniMaxRequestOptions({ thinking: "disabled", reasoningSplit: true, maxCompletionTokens: 2_048 }, "MiniMax-M3")
    const body = JSON.parse(buildMiniMaxRequestBody(JSON.stringify({
      model: "wrong-model", max_tokens: 2_048, stream: true, stream_options: { include_usage: true },
    }), options)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: "MiniMax-M3", max_completion_tokens: 2_048, reasoning_split: true,
      thinking: { type: "disabled" }, stream: true,
    })
    expect(body).not.toHaveProperty("max_tokens")
  })

  it("rejects invalid request limits with a typed error", () => {
    expect(() => miniMaxRequestOptions({ maxCompletionTokens: 0 }, "MiniMax-M3")).toThrowError(AgentModelError)
    expect(() => buildMiniMaxRequestBody("not-json", miniMaxRequestOptions({}, "MiniMax-M3"))).toThrowError(AgentModelError)
  })
})
