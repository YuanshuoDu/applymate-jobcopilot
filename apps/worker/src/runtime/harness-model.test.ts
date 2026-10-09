import { describe, expect, it, vi } from "vitest"

import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import { createHarnessModelRuntime, type HarnessFetch } from "./harness-model.js"
import { ContextEstimateExceededError } from "./turns/model-request-admission.js"

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

function requestWithText(text: string): HarnessModelRequest {
  return { ...request(), messages: [{ role: "user", content: [{ type: "text", text }] }] }
}

function setRouteContextWindow(runtime: ReturnType<typeof createHarnessModelRuntime>, provider: string, model: string, maxContextTokens: number): void {
  const adapter = runtime.registry.list().find(item => item.profile.provider === provider && item.profile.model === model)
  if (!adapter) throw new Error(`fixture route missing: ${provider}/${model}`)
  runtime.registry.unregister(adapter.id)
  runtime.registry.register({ ...adapter, profile: { ...adapter.profile, maxContextTokens } })
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

  it("can require explicit route credentials without discovering environment fallbacks", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "environment-key")
    try {
      expect(() => createHarnessModelRuntime({
        primary: { provider: "anthropic", model: "claude-sonnet-5" },
        allowEnvironmentFallbacks: false,
        fetch: vi.fn() as unknown as HarnessFetch,
      })).toThrow("No Harness model route has an API key configured")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("uses only the platform MiniMax env key when generic environment fallbacks are disabled", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "platform-key")
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-environment-key")
    vi.stubEnv("OPENAI_API_KEY", "openai-environment-key")
    const fetcher: HarnessFetch = vi.fn(async (_url, init) => {
      expect(init.headers.Authorization).toBe("Bearer platform-key")
      return streamResponse([], 503)
    })
    try {
      const runtime = createHarnessModelRuntime({
        primary: { provider: "minimax", model: "MiniMax-M3", credentialSource: "platform" },
        fallbacks: [],
        allowEnvironmentFallbacks: false,
        fetch: fetcher,
      })

      expect(runtime.candidates).toHaveLength(1)
      expect(runtime.candidates[0]).toMatchObject({
        target: { provider: "minimax", model: "MiniMax-M3" },
        requirement: { nativeTools: true, streaming: true },
      })
      await expect((async () => {
        for await (const _event of runtime.adapter.stream(request())) undefined
      })()).rejects.toMatchObject({ code: "provider_error" })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does not use platform MiniMax credentials for user or custom routes", () => {
    vi.stubEnv("MINIMAX_API_KEY", "platform-key")
    vi.stubEnv("OPENAI_API_KEY", "openai-environment-key")
    try {
      for (const primary of [
        { provider: "minimax", model: "MiniMax-M3", credentialSource: "user" },
        { provider: "openai", model: "gpt-5.5" },
        { provider: "custom", model: "custom-model", apiBase: "https://custom.example/v1", credentialSource: "user" },
      ] as const) {
        expect(() => createHarnessModelRuntime({
          primary,
          allowEnvironmentFallbacks: false,
          fetch: vi.fn() as unknown as HarnessFetch,
        })).toThrow("No Harness model route has an API key configured")
      }
    } finally {
      vi.unstubAllEnvs()
    }
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

  it("skips an oversized primary and captures the unchanged final request on a larger fitting fallback", async () => {
    const privateText = "original task reference " + "x".repeat(1_700_000)
    const calls: string[] = [], diagnostics: unknown[] = []
    const fetcher: HarnessFetch = vi.fn(async (url, init) => {
      calls.push(url)
      expect(url).toContain("anthropic")
      const body = JSON.parse(init.body) as { model: string; messages: unknown[] }
      expect(body.model).toBe("claude-sonnet-5")
      expect(JSON.stringify(body.messages)).toContain(privateText)
      return streamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Fitting fallback"}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ])
    })
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }],
      allowEnvironmentFallbacks: false, fetch: fetcher,
      onRequestAdmission: diagnostic => diagnostics.push(diagnostic),
    })
    setRouteContextWindow(runtime, "anthropic", "claude-sonnet-5", 800_000)
    const events = []
    for await (const event of runtime.adapter.stream(requestWithText(privateText))) events.push(event)

    expect(events).toContainEqual({ type: "text_delta", text: "Fitting fallback" })
    expect(calls).toHaveLength(1)
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]).toMatchObject({ provider: "minimax", status: "known", withinWindow: false })
    expect(diagnostics[1]).toMatchObject({ provider: "anthropic", status: "known", withinWindow: true })
    expect(JSON.stringify(diagnostics)).not.toContain(privateText)
  })

  it("keeps an unknown-metadata fallback eligible and reports its estimate as unknown", async () => {
    const privateText = "private unknown-route context " + "y".repeat(1_700_000)
    const diagnostics: unknown[] = [], fetcher: HarnessFetch = vi.fn(async url => {
      expect(url).toContain("anthropic")
      return streamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Unknown eligible"}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ])
    })
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }],
      allowEnvironmentFallbacks: false, fetch: fetcher,
      onRequestAdmission: diagnostic => diagnostics.push(diagnostic),
    })
    const events = []
    for await (const event of runtime.adapter.stream(requestWithText(privateText))) events.push(event)

    expect(events).toContainEqual({ type: "text_delta", text: "Unknown eligible" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]).toMatchObject({ provider: "minimax", status: "known", withinWindow: false })
    expect(diagnostics[1]).toMatchObject({ provider: "anthropic", status: "unknown", method: "unknown" })
    expect(JSON.stringify(diagnostics)).not.toContain(privateText)
  })

  it("returns one local error without fetch when every eligible known route is over window", async () => {
    const fetcher: HarnessFetch = vi.fn(async () => { throw new Error("known oversized route reached fetch") })
    const diagnostics: unknown[] = []
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }],
      allowEnvironmentFallbacks: false, fetch: fetcher,
      onRequestAdmission: diagnostic => diagnostics.push(diagnostic),
    })
    setRouteContextWindow(runtime, "anthropic", "claude-sonnet-5", 400_000)
    let caught: unknown
    try { for await (const _event of runtime.adapter.stream(requestWithText("x".repeat(1_700_000)))) undefined }
    catch (error: unknown) { caught = error }

    expect(caught).toBeInstanceOf(ContextEstimateExceededError)
    expect(caught).toMatchObject({ code: "context_estimate_exceeded", guaranteedNoProviderAttempt: true,
      provider: "anthropic", model: "claude-sonnet-5", retryable: false, recoverable: false })
    expect(fetcher).not.toHaveBeenCalled()
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics.every(item => (item as { status?: string }).status === "known")).toBe(true)
  })

  it("does not claim zero provider attempts when a prior route was invoked before local rejection", async () => {
    const fetcher: HarnessFetch = vi.fn(async () => streamResponse([], 503))
    const diagnostics: unknown[] = [], selection: string[] = []
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }],
      allowEnvironmentFallbacks: false, fetch: fetcher, onRequestAdmission: diagnostic => diagnostics.push(diagnostic),
      onSelectionEvent: event => selection.push(event.type),
    })
    setRouteContextWindow(runtime, "anthropic", "claude-sonnet-5", 128_000)
    let caught: unknown
    try { for await (const _event of runtime.adapter.stream(requestWithText("x".repeat(500_000)))) undefined }
    catch (error: unknown) { caught = error }

    expect(caught).toBeInstanceOf(ContextEstimateExceededError)
    expect(caught).toMatchObject({ code: "context_estimate_exceeded", guaranteedNoProviderAttempt: false,
      provider: "anthropic", model: "claude-sonnet-5" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]).toMatchObject({ provider: "minimax", status: "known", withinWindow: true })
    expect(diagnostics[1]).toMatchObject({ provider: "anthropic", status: "known", withinWindow: false })
    expect(selection).not.toContain("model.usage")
  })

  it.each([
    ["zero reroutes", { maxReroutes: 0 }],
    ["irreversible action", { irreversibleActionStarted: true }],
    ["throwing irreversible predicate", { irreversibleActionStarted: () => { throw new Error("state unavailable") } }],
  ])("keeps the selector fence for an oversized primary (%s)", async (_label, routing) => {
    const fetcher: HarnessFetch = vi.fn(async () => { throw new Error("oversized primary reached fetch") })
    const diagnostics: unknown[] = []
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }],
      allowEnvironmentFallbacks: false, fetch: fetcher, onRequestAdmission: diagnostic => diagnostics.push(diagnostic), ...routing,
    })
    setRouteContextWindow(runtime, "anthropic", "claude-sonnet-5", 800_000)
    let caught: unknown
    try { for await (const _event of runtime.adapter.stream(requestWithText("x".repeat(1_700_000)))) undefined }
    catch (error: unknown) { caught = error }

    expect(caught).toBeInstanceOf(ContextEstimateExceededError)
    expect(caught).toMatchObject({ code: "context_estimate_exceeded", guaranteedNoProviderAttempt: true })
    expect(fetcher).not.toHaveBeenCalled()
    expect(diagnostics).toHaveLength(1)
  })
})
