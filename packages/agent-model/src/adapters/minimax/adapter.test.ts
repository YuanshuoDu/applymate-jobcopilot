import { afterEach, describe, expect, it, vi } from "vitest"

import { MODEL_SCHEMA_VERSION, type HarnessModelRequest } from "../../contracts.js"
import { createMiniMaxAdapter, createMiniMaxM3Adapter } from "./adapter.js"

afterEach(() => vi.unstubAllEnvs())

function request(signal = new AbortController().signal): HarnessModelRequest {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: "minimax",
    model: "MiniMax-M3",
    messages: [{ role: "user", content: [{ type: "text", text: "Find Berlin jobs" }] }],
    tools: [],
    capabilities: { nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false },
    signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "p1", taskId: "k1" },
  }
}

function response(lines: string[], status = 200): Response {
  return new Response(lines.join("\n"), { status, headers: { "Content-Type": "text/event-stream" } })
}

describe("MiniMax provider profile", () => {
  it("accepts the existing provider/apiBase config shape and defaults to M3", () => {
    const adapter = createMiniMaxM3Adapter({ provider: "minimax", apiBase: "https://api.minimax.io/v1", platformApiKey: "platform-key" })
    expect(adapter.config).toEqual({ model: "MiniMax-M3", baseUrl: "https://api.minimax.io/v1" })
    expect(adapter.credentialSource).toBe("platform")
  })

  it("resolves the China Token Plan endpoint from MINIMAX_REGION", () => {
    vi.stubEnv("MINIMAX_REGION", "cn")
    const adapter = createMiniMaxM3Adapter({ platformApiKey: "platform-key" })
    expect(adapter.config).toMatchObject({ model: "MiniMax-M3", baseUrl: "https://api.minimax.cn/v1" })
  })

  it("uses the generic adapter while sending MiniMax M3 options and normalizing reasoning", async () => {
    const fetcher = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      expect(body).toMatchObject({
        model: "MiniMax-M3", max_completion_tokens: 1_024, reasoning_split: true,
        thinking: { type: "adaptive" },
      })
      expect(body).not.toHaveProperty("max_tokens")
      return response([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ text: "Plan" }] } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ text: "Plan carefully" }] } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Done" } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } })}`,
        "",
        "data: [DONE]",
        "",
      ])
    })
    const adapter = createMiniMaxAdapter({ apiKey: "user-key", maxCompletionTokens: 1_024 }, { fetch: fetcher })
    const events: unknown[] = []
    for await (const event of adapter.stream(request())) events.push(event)
    expect(adapter.id).toBe("minimax:MiniMax-M3")
    expect(adapter.profile).toMatchObject({ provider: "minimax", model: "MiniMax-M3", supportsReasoningSummary: true })
    expect(adapter.credentialSource).toBe("user")
    expect(events).toContainEqual({ type: "reasoning_summary_delta", text: "Plan" })
    expect(events).toContainEqual({ type: "reasoning_summary_delta", text: " carefully" })
    expect(events).toContainEqual({ type: "text_delta", text: "Done" })
    expect(events).toContainEqual({ type: "usage", inputTokens: 3, outputTokens: 4 })
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "stop" })
  })

  it("preserves typed cancellation before invoking the provider", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = vi.fn(async () => response([]))
    const adapter = createMiniMaxAdapter({ apiKey: "key" }, { fetch: fetcher })
    await expect(adapter.stream(request(controller.signal)).next()).rejects.toMatchObject({ code: "cancelled" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("passes MiniMax tool-call chunks through the provider-neutral accumulator", async () => {
    const fetcher = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      expect(body.tools).toEqual([{
        type: "function", function: { name: "jobs.search", parameters: { type: "object" } },
      }])
      return response([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "jobs.search", arguments: '{"q":"' } }] } }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "Dublin\"}" } }] }, finish_reason: "tool_calls" }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } })}`,
        "",
        "data: [DONE]",
        "",
      ])
    })
    const adapter = createMiniMaxAdapter({ apiKey: "key" }, { fetch: fetcher })
    const result = await adapter.complete?.({
      ...request(),
      tools: [{ name: "jobs.search", inputSchema: { type: "object" } }],
    })
    expect(result).toMatchObject({
      provider: "minimax", model: "MiniMax-M3", finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "jobs.search", arguments: { q: "Dublin" } }],
      usage: { inputTokens: 5, outputTokens: 3 },
    })
  })

  it("supports disabled thinking without changing the provider or model identity", async () => {
    const fetcher = vi.fn(async (_url: string, init: { body: string }) => {
      expect(JSON.parse(init.body)).toMatchObject({ thinking: { type: "disabled" }, reasoning_split: false })
      return response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}`,
        "",
        "data: [DONE]",
        "",
      ])
    })
    const adapter = createMiniMaxAdapter({ apiKey: "key", thinking: "disabled", reasoningSplit: false }, { fetch: fetcher })
    const result = await adapter.complete?.(request())
    expect(result).toMatchObject({ provider: "minimax", model: "MiniMax-M3", finishReason: "stop", text: "ok" })
    expect(adapter.thinking).toBe("disabled")
    expect(adapter.reasoningSplit).toBe(false)
  })
})
