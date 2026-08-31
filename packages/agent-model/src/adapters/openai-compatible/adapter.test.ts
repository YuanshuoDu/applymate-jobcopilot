import { describe, expect, it, vi } from "vitest"

import { MODEL_SCHEMA_VERSION, type HarnessModelRequest } from "../../contracts.js"
import { createOpenAiCompatibleAdapter } from "./adapter.js"
import { capabilityProfile } from "./request.js"

const config = { provider: "openai-compatible", model: "gpt-test", baseUrl: "https://api.example.com/v1", apiKey: "secret" }

function sse(events: Array<{ event?: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const text = events.map((event) => `${event.event ? `event: ${event.event}\n` : ""}data: ${typeof event.data === "string" ? event.data : JSON.stringify(event.data)}\n\n`).join("")
  return new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close() } })
}

function request(overrides: Partial<HarnessModelRequest> = {}): HarnessModelRequest {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION, provider: config.provider, model: config.model,
    messages: [{ role: "user", content: [{ type: "text", text: "Find jobs" }] }], tools: [],
    capabilities: capabilityProfile(config, "chat_completions"), signal: new AbortController().signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "p1", taskId: "k1" }, ...overrides,
  }
}

function chatEvents() {
  return [
    { data: { choices: [{ delta: { content: "Found " } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "jobs.search", arguments: '{"q":"' } }] } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "jobs.get", arguments: '{"id":"2"}' } }] } }] } },
    { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Berlin"}' } }] }, finish_reason: "tool_calls" }] } },
    { data: { choices: [], usage: { prompt_tokens: 9, completion_tokens: 7 } } },
    { data: "[DONE]" },
  ]
}

async function consume<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe("OpenAI-compatible adapter", () => {
  it("sends a pinned-compatible request and emits complete ordered tool calls", async () => {
    const fetcher = vi.fn(async () => new Response(sse(chatEvents()), { status: 200 }))
    const adapter = createOpenAiCompatibleAdapter(config, { fetch: fetcher })
    const events = []
    for await (const event of adapter.stream(request())) events.push(event)
    expect(events.filter((event) => event.type === "tool_call_completed")).toEqual([
      { type: "tool_call_completed", callId: "call_a", name: "jobs.search", arguments: { q: "Berlin" } },
      { type: "tool_call_completed", callId: "call_b", name: "jobs.get", arguments: { id: "2" } },
    ])
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/chat/completions"), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const init = fetcher.mock.calls[0]?.[1]
    expect(init?.body).not.toContain("secret")
  })

  it("maps Responses completion to a protocol response with continuation cursor", async () => {
    const fetcher = vi.fn(async () => new Response(sse([
      { event: "response.output_text.delta", data: { delta: "Hello" } },
      { event: "response.completed", data: { response: { id: "resp_1", usage: { input_tokens: 2, output_tokens: 1 } } } },
    ]), { status: 200 }))
    const adapter = createOpenAiCompatibleAdapter({ ...config, mode: "responses" }, { fetch: fetcher })
    const response = await adapter.complete?.(request({ capabilities: capabilityProfile(config, "responses") }))
    expect(response).toMatchObject({ text: "Hello", finishReason: "stop", continuationCursor: "resp_1", toolCalls: [] })
    expect(response?.usage).toEqual({ inputTokens: 2, outputTokens: 1, estimatedCostUsd: 0 })
  })

  it("maps continuation HTTP loss, provider failures, and aborts to typed errors", async () => {
    const lost = vi.fn(async () => new Response("{}", { status: 404 }))
    const responses = createOpenAiCompatibleAdapter({ ...config, mode: "responses" }, { fetch: lost })
    await expect(responses.stream(request({ capabilities: capabilityProfile(config, "responses"), continuation: { providerResponseId: "missing" } })).next()).rejects.toMatchObject({ code: "cursor_lost", recoverable: true })

    const failed = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "2" } }))
    const failing = createOpenAiCompatibleAdapter(config, { fetch: failed })
    await expect(failing.stream(request()).next()).rejects.toMatchObject({ code: "provider_error", retryAfterMs: 2_000 })

    const unavailable = vi.fn(async () => new Response("{}", { status: 503 }))
    const unavailableAdapter = createOpenAiCompatibleAdapter(config, { fetch: unavailable })
    await expect(unavailableAdapter.stream(request()).next()).rejects.toMatchObject({ code: "provider_error", retryable: true })

    const controller = new AbortController()
    const abortable = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      controller.abort()
    }))
    const cancelled = createOpenAiCompatibleAdapter(config, { fetch: abortable })
    await expect(cancelled.stream(request({ signal: controller.signal })).next()).rejects.toMatchObject({ code: "cancelled" })
    expect(abortable).toHaveBeenCalled()
  })

  it("cancels an in-flight stream reader when the caller aborts", async () => {
    const controller = new AbortController()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start() { /* Hold the stream until the caller cancels. */ },
      cancel() { cancelled = true },
    })
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }))
    const adapter = createOpenAiCompatibleAdapter(config, { fetch: fetcher })
    const consuming = consume(adapter.stream(request({ signal: controller.signal })))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(consuming).rejects.toMatchObject({ code: "cancelled" })
    expect(cancelled).toBe(true)
  })

  it("maps an internal timeout to a recoverable timeout error", async () => {
    const hanging = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true })
    }))
    const adapter = createOpenAiCompatibleAdapter(config, { fetch: hanging, timeoutMs: 10 })
    await expect(consume(adapter.stream(request()))).rejects.toMatchObject({ code: "timeout", retryable: true })
  })

  it("fails closed on a truncated tool stream and malformed server JSON", async () => {
    const truncated = vi.fn(async () => new Response(sse([
      { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "jobs.search", arguments: "{" } }] }, finish_reason: "length" }] } },
      { data: "[DONE]" },
    ]), { status: 200 }))
    const adapter = createOpenAiCompatibleAdapter(config, { fetch: truncated })
    await expect(consume(adapter.stream(request()))).rejects.toMatchObject({ code: "malformed_response" })

    const malformed = vi.fn(async () => new Response(sse([{ data: "not-json" }, { data: "[DONE]" }]), { status: 200 }))
    const invalid = createOpenAiCompatibleAdapter(config, { fetch: malformed })
    await expect(consume(invalid.stream(request()))).rejects.toMatchObject({ code: "malformed_response" })

    const missingDone = vi.fn(async () => new Response(sse([
      { data: { choices: [{ delta: { content: "partial" }, finish_reason: "stop" }] } },
    ]), { status: 200 }))
    const incomplete = createOpenAiCompatibleAdapter(config, { fetch: missingDone })
    await expect(consume(incomplete.stream(request()))).rejects.toMatchObject({ code: "malformed_response" })
  })
})
