import { describe, expect, it, vi } from "vitest"

import { MODEL_SCHEMA_VERSION, type HarnessModelRequest } from "../../contracts.js"
import { createAnthropicAdapter } from "./adapter.js"

function request(signal = new AbortController().signal): HarnessModelRequest {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: "anthropic",
    model: "claude-test",
    messages: [{ role: "user", content: [{ type: "text", text: "Find jobs" }] }],
    tools: [],
    capabilities: { nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false },
    signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "p1", taskId: "k1" },
  }
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } })
}

const config = { provider: "anthropic", model: "claude-test", baseUrl: "https://api.anthropic.com", apiKey: "secret" }

describe("Anthropic Messages adapter", () => {
  it("normalizes a zero-network stream and keeps usage observable", async () => {
    const fetcher = vi.fn(async () => response([
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Ready\"}}",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}",
      "",
    ].join("\n\n")))
    const adapter = createAnthropicAdapter(config, { fetch: fetcher })
    const events: unknown[] = []
    for await (const event of adapter.stream(request())) events.push(event)
    expect(fetcher).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({
      method: "POST", signal: expect.any(AbortSignal),
    }))
    expect(events).toContainEqual({ type: "text_delta", text: "Ready" })
    expect(events).toContainEqual({ type: "usage", inputTokens: 3, outputTokens: 4 })
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "stop" })
  })

  it("returns a normalized complete response with tool calls", async () => {
    const fetcher = vi.fn(async () => response([
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"jobs_x2e_search\",\"input\":{}}}",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"q\\\":\\\"Dublin\\\"}\"}}",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":2}}",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}",
      "",
    ].join("\n\n")))
    const adapter = createAnthropicAdapter(config, { fetch: fetcher })
    const result = await adapter.complete?.({
      ...request(),
      tools: [{ name: "jobs.search", inputSchema: { type: "object" } }],
    })
    expect(result).toMatchObject({
      provider: "anthropic", model: "claude-test", finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "jobs.search", arguments: { q: "Dublin" } }],
      usage: { inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0 },
    })
  })

  it("normalizes caller cancellation and internal timeout", async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    const fetcher = vi.fn(async () => response(""))
    const adapter = createAnthropicAdapter(config, { fetch: fetcher })
    await expect(adapter.stream(request(cancelled.signal)).next()).rejects.toMatchObject({ code: "cancelled" })
    expect(fetcher).not.toHaveBeenCalled()

    const hanging = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true })
    }))
    const timed = createAnthropicAdapter(config, { fetch: hanging, timeoutMs: 10 })
    await expect(timed.stream(request()).next()).rejects.toMatchObject({ code: "timeout", retryable: true })
  })
})
