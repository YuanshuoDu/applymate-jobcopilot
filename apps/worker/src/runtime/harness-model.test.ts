import { describe, expect, it, vi } from "vitest"

import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import { createHarnessModelRuntime, type HarnessFetch } from "./harness-model.js"

function request(): HarnessModelRequest {
  return {
    schemaVersion: "agent-harness.v2",
    provider: "minimax",
    model: "MiniMax-M3",
    messages: [{ role: "user", content: [{ type: "text", text: "Find Dublin jobs" }] }],
    tools: [{ name: "jobs.search", inputSchema: { type: "object" } }],
    capabilities: { nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false },
    signal: new AbortController().signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "step-1", taskId: "task-1" },
  }
}

function streamResponse(events: readonly string[], status = 200): Response {
  return new Response(events.join("\n\n"), { status, headers: { "Content-Type": "text/event-stream" } })
}

describe("Harness model runtime", () => {
  it("resolves the platform MiniMax key when no route is supplied", () => {
    vi.stubEnv("MINIMAX_API_KEY", "platform-key")
    try {
      const runtime = createHarnessModelRuntime({ fetch: vi.fn() as unknown as HarnessFetch })
      expect(runtime.candidates[0]).toMatchObject({
        target: { provider: "minimax", model: "MiniMax-M3" },
        requirement: { nativeTools: true, streaming: true },
      })
      expect(runtime.adapter.profile).toMatchObject({ provider: "minimax", model: "MiniMax-M3" })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("makes MiniMax M3 the default native-tool route", () => {
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "platform-key", credentialSource: "platform" },
      fetch: vi.fn() as unknown as HarnessFetch,
    })
    expect(runtime.adapter.profile).toMatchObject({ provider: "minimax", model: "MiniMax-M3", nativeTools: true, streaming: true })
    expect(runtime.candidates[0]).toMatchObject({ target: { provider: "minimax", model: "MiniMax-M3" }, requirement: { nativeTools: true, streaming: true } })
  })

  it("reroutes a failed MiniMax request to Anthropic without publishing a partial response", async () => {
    const selection: string[] = []
    let call = 0
    const fetcher: HarnessFetch = vi.fn(async (url, init) => {
      call += 1
      if (call === 1) {
        expect(url).toContain("minimax")
        expect(JSON.parse(init.body)).toMatchObject({ model: "MiniMax-M3", tools: [{ type: "function" }] })
        return streamResponse([], 503)
      }
      expect(url).toContain("anthropic")
      return streamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Fallback ready"}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ])
    })
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }],
      fetch: fetcher,
      onSelectionEvent: (event) => selection.push(event.type),
    })
    const events = []
    for await (const event of runtime.adapter.stream(request())) events.push(event)
    expect(events).toContainEqual({ type: "text_delta", text: "Fallback ready" })
    expect(selection).toContain("model.rerouted")
    expect(selection).toContain("model.usage")
    expect(events.find((event) => event.type === "usage")).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: expect.any(Number) })
    expect(call).toBe(2)
  })

  it("does not reroute after the caller marks an irreversible action", async () => {
    const fetcher: HarnessFetch = vi.fn(async () => streamResponse([], 503))
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }],
      fetch: fetcher,
      irreversibleActionStarted: true,
    })
    await expect((async () => { for await (const _event of runtime.adapter.stream(request())) undefined })()).rejects.toMatchObject({ code: "provider_error" })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
