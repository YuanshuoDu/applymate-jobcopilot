import { describe, expect, it, vi } from "vitest"
import {
  MODEL_SCHEMA_VERSION,
  type HarnessModelRequest,
  type ModelAdapter,
  type ModelCapabilityProfile,
  type ModelResponse,
  type ModelStreamEvent,
} from "@jobcopilot/agent-model"
import { estimateSharedAiCost } from "@jobcopilot/shared"
import type { HarnessModelRuntime } from "./harness-model.js"
import { defaultAuthorization, modelWithUsage } from "./canonical-turn-runtime-model.js"
import { createHarnessModelRuntime, type HarnessFetch } from "./harness-model.js"
import type { TurnLease } from "./turns/lease.js"

const lease: TurnLease = {
  turnId: "turn-1",
  sessionId: "session-1",
  ownerId: "worker-7",
  userId: "user-9",
  leaseVersion: 4,
  leaseStartedAt: new Date("2026-09-30T10:00:00.000Z"),
  leaseExpiresAt: new Date("2026-09-30T10:01:00.000Z"),
}

const profile: ModelCapabilityProfile = {
  provider: "fixture-provider",
  model: "fixture-model",
  nativeTools: true,
  structuredOutput: true,
  streaming: true,
  continuationCursor: false,
  supportsParallelTools: false,
  supportsStreamingToolArgs: false,
  supportsReasoningSummary: false,
  supportsResponseContinuation: false,
  supportsProviderConversation: false,
  supportsBackgroundResponse: false,
  maxContextTokens: null,
  maxOutputTokens: null,
  costClass: "low",
}

function request(stepId = "request-step"): HarnessModelRequest {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: "request-provider",
    model: "request-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false },
    signal: new AbortController().signal,
    metadata: { sessionId: "request-session", turnId: "request-turn", stepId, taskId: "request-task" },
  }
}

function adapter(
  stream: ModelAdapter["stream"],
  complete?: NonNullable<ModelAdapter["complete"]>,
): ModelAdapter {
  return { id: "fixture-adapter", profile, stream, ...(complete ? { complete } : {}) }
}

function runtime(value: ModelAdapter): HarnessModelRuntime {
  return { adapter: value, registry: {} as never, candidates: [] }
}

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const values: ModelStreamEvent[] = []
  for await (const event of events) values.push(event)
  return values
}

function response(usage: ModelResponse["usage"]): ModelResponse {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: profile.provider,
    model: profile.model,
    finishReason: "stop",
    toolCalls: [],
    usage,
    continuationCursor: null,
  }
}

function setRouteContextWindow(runtime: ReturnType<typeof createHarnessModelRuntime>, provider: string, maxContextTokens: number): void {
  const route = runtime.registry.list().find(item => item.profile.provider === provider)
  if (!route) throw new Error(`fixture route missing: ${provider}`)
  runtime.registry.unregister(route.id)
  runtime.registry.register({ ...route, profile: { ...route.profile, maxContextTokens, defaultMaxOutputTokens: 64 } })
}

function harnessRuntime(fetcher: HarnessFetch, contexts: readonly [number, number?], onRequestAdmission?: () => void) {
  const runtime = createHarnessModelRuntime({
    primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "minimax-key" },
    ...(contexts[1] === undefined ? {} : { fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "anthropic-key" }] }),
    allowEnvironmentFallbacks: false, fetch: fetcher, onRequestAdmission,
  })
  setRouteContextWindow(runtime, "minimax", contexts[0])
  if (contexts[1] !== undefined) setRouteContextWindow(runtime, "anthropic", contexts[1])
  return runtime
}

function oversizedRequest(): HarnessModelRequest {
  return { ...request(), maxOutputTokens: 64, messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(9000) }] }] }
}

function fittingFallbackResponse(): Response {
  return new Response([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Fitting fallback"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } })
}

function failedMinimaxStreamResponse(): Response {
  const data = JSON.stringify({
    choices: [{ delta: {
      content: "Primary partial text",
      tool_calls: [{ index: 0, id: "primary-call", type: "function", function: { name: "jobs.search", arguments: '{"query":"hidden"}' } }],
    } }],
    usage: { prompt_tokens: 29, completion_tokens: 31 },
  })
  let emitted = false
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emitted) {
        emitted = true
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
      } else controller.error(new Error("provider stream interrupted"))
    },
  }), { headers: { "Content-Type": "text/event-stream" } })
}

function expectedCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  return estimateSharedAiCost({ provider, model, credentialSource: "user", inputTokens, outputTokens, latencyMs: 0, status: "success" })
}

describe("canonical turn runtime usage model", () => {
  it("authorizes against the lease identity, autoApply feature, adapter route, and request step", async () => {
    const order: string[] = []
    const events = [{ type: "completed", finishReason: "stop" } satisfies ModelStreamEvent]
    const authorize = vi.fn(async () => { order.push("authorize"); return { settle: vi.fn() } })
    const wrapped = modelWithUsage(runtime(adapter(async function* () { order.push("stream"); yield* events })), lease, authorize)

    await collect(wrapped.stream(request("step-from-request")))

    expect(authorize).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledWith({
      userId: "user-9",
      sessionId: "session-1",
      turnId: "turn-1",
      stepId: "step-from-request",
      leaseOwnerId: "worker-7",
      leaseVersion: 4,
      featureKey: "autoApply",
      provider: "fixture-provider",
      model: "fixture-model",
    })
    expect(order).toEqual(["authorize", "stream"])
  })

  it("settles stream usage once after successful completion", async () => {
    const settlement = vi.fn()
    const authorize = vi.fn(async () => ({ settle: settlement }))
    const wrapped = modelWithUsage(runtime(adapter(async function* () {
      yield { type: "usage", inputTokens: 17, outputTokens: 6, estimatedCostUsd: 0.025 }
      yield { type: "completed", finishReason: "stop" }
    })), lease, authorize)

    await expect(collect(wrapped.stream(request()))).resolves.toHaveLength(2)
    expect(settlement).toHaveBeenCalledTimes(1)
    expect(settlement).toHaveBeenCalledWith({ status: "success", inputTokens: 17, outputTokens: 6, estimatedCostUsd: 0.025 })
  })

  it("settles a consumer-interrupted provider stream once with partial usage and closes its iterator", async () => {
    const settlement = vi.fn(), providerClosed = vi.fn()
    const wrapped = modelWithUsage(runtime(adapter(async function* () {
      try {
        yield { type: "usage", inputTokens: 17, outputTokens: 6, estimatedCostUsd: 0.025 }
        yield { type: "text_delta", text: "partial" }
      } finally { providerClosed() }
    })), lease, async () => ({ settle: settlement }))
    const iterator = wrapped.stream(request())[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false, value: { type: "usage", inputTokens: 17, outputTokens: 6, estimatedCostUsd: 0.025 },
    })
    expect(iterator.return).toBeTypeOf("function")
    await iterator.return?.()
    await iterator.return?.()

    expect(providerClosed).toHaveBeenCalledOnce()
    expect(settlement).toHaveBeenCalledOnce()
    expect(settlement).toHaveBeenCalledWith({
      status: "error", inputTokens: 17, outputTokens: 6, estimatedCostUsd: 0.025, errorCode: "model_stream_interrupted",
    })
  })

  it("settles stream usage once on provider error and preserves its stable code", async () => {
    const settlement = vi.fn()
    const failure = Object.assign(new Error("provider detail"), { code: "provider_error" })
    const wrapped = modelWithUsage(runtime(adapter(async function* () {
      yield { type: "usage", inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0.01 }
      throw failure
    })), lease, async () => ({ settle: settlement }))

    await expect(collect(wrapped.stream(request()))).rejects.toBe(failure)
    expect(settlement).toHaveBeenCalledTimes(1)
    expect(settlement).toHaveBeenCalledWith({ status: "error", inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0.01, errorCode: "provider_error" })
  })

  it("settles complete usage once and returns the provider response", async () => {
    const settlement = vi.fn()
    const providerResponse = response({ inputTokens: 11, outputTokens: 5, estimatedCostUsd: 0.03 })
    const wrapped = modelWithUsage(runtime(adapter(
      async function* () { yield { type: "completed", finishReason: "stop" } },
      async () => providerResponse,
    )), lease, async () => ({ settle: settlement }))

    await expect(wrapped.complete?.(request())).resolves.toBe(providerResponse)
    expect(settlement).toHaveBeenCalledTimes(1)
    expect(settlement).toHaveBeenCalledWith({ status: "success", inputTokens: 11, outputTokens: 5, estimatedCostUsd: 0.03 })
  })

  it("does not admit a complete request when cancellation already happened", async () => {
    const controller = new AbortController(), complete = vi.fn(async () => response(null)), authorize = vi.fn()
    controller.abort(new Error("already cancelled"))
    const wrapped = modelWithUsage(runtime(adapter(async function* () { yield { type: "completed", finishReason: "stop" } }, complete)), lease, authorize)

    await expect(wrapped.complete?.({ ...request(), signal: controller.signal })).rejects.toThrow("already cancelled")
    expect(authorize).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it("settles complete provider errors once with a stable error code", async () => {
    const settlement = vi.fn()
    const failure = Object.assign(new Error("provider detail"), { code: "complete_provider_error" })
    const wrapped = modelWithUsage(runtime(adapter(
      async function* () { yield { type: "completed", finishReason: "stop" } },
      async () => { throw failure },
    )), lease, async () => ({ settle: settlement }))

    await expect(wrapped.complete?.(request())).rejects.toBe(failure)
    expect(settlement).toHaveBeenCalledTimes(1)
    expect(settlement).toHaveBeenCalledWith({ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: "complete_provider_error" })
  })

  it("fails closed before invoking the provider when default authorization is used", async () => {
    const stream = vi.fn(async function* () { yield { type: "completed", finishReason: "stop" } satisfies ModelStreamEvent })
    const wrapped = modelWithUsage(runtime(adapter(stream)), lease, defaultAuthorization)

    await expect(collect(wrapped.stream(request()))).rejects.toMatchObject({
      message: "usage_authorization_unavailable",
      code: "usage_authorization_unavailable",
    })
    expect(stream).not.toHaveBeenCalled()
  })

  it("skips finite-credit authorization and settlement when every Harness route fails preflight", async () => {
    const fetcher = vi.fn(async () => { throw new Error("preflight reached fetch") })
    const runtime = harnessRuntime(fetcher, [500, 500])
    const settlement = vi.fn()
    const authorize = vi.fn(async () => ({ settle: settlement }))
    const wrapped = modelWithUsage(runtime, lease, authorize)

    await expect(collect(wrapped.stream(oversizedRequest())))
      .rejects.toMatchObject({ code: "context_estimate_exceeded", guaranteedNoProviderAttempt: true })
    expect(authorize).not.toHaveBeenCalled()
    expect(settlement).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("authorizes once after the fitting fallback preflight and before fetching that route", async () => {
    const order: string[] = []
    const fetcher: HarnessFetch = vi.fn(async url => { order.push("fetch"); expect(url).toContain("anthropic"); return fittingFallbackResponse() })
    const runtime = harnessRuntime(fetcher, [500, 5000], () => { order.push("preflight") })
    const settlement = vi.fn()
    const authorize = vi.fn(async input => { order.push(`authorize:${input.provider}`); return { settle: settlement } })
    const wrapped = modelWithUsage(runtime, lease, authorize)

    const events = await collect(wrapped.stream(oversizedRequest()))
    expect(events).toContainEqual({ type: "text_delta", text: "Fitting fallback" })
    expect(order).toEqual(["preflight", "preflight", "authorize:anthropic", "fetch"])
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(settlement).toHaveBeenCalledOnce()
  })

  it("authorizes and settles each started Harness route independently", async () => {
    const order: string[] = [], urls: string[] = [], settlements = new Map<string, ReturnType<typeof vi.fn>>()
    const fetcher: HarnessFetch = vi.fn(async url => {
      const provider = url.includes("anthropic") ? "anthropic" : "minimax"
      urls.push(provider)
      order.push(`fetch:${provider}`)
      return provider === "minimax" ? new Response("temporarily unavailable", { status: 503 }) : fittingFallbackResponse()
    })
    const runtime = harnessRuntime(fetcher, [5000, 5000], () => { order.push("preflight") })
    const authorize = vi.fn(async input => {
      order.push(`authorize:${input.provider}`)
      const settle = vi.fn(), release = vi.fn()
      settlements.set(input.provider, settle)
      return { settle, release }
    })
    const wrapped = modelWithUsage(runtime, lease, authorize)

    const events = await collect(wrapped.stream(request()))
    expect(events).toContainEqual({ type: "text_delta", text: "Fitting fallback" })
    expect(urls).toEqual(["minimax", "anthropic"])
    expect(order).toEqual([
      "preflight", "authorize:minimax", "fetch:minimax", "preflight", "authorize:anthropic", "fetch:anthropic",
    ])
    expect(authorize.mock.calls.map(([input]) => `${input.provider}/${input.model}`)).toEqual([
      "minimax/MiniMax-M3", "anthropic/claude-sonnet-5",
    ])
    expect(settlements.get("minimax")).toHaveBeenCalledOnce()
    expect(settlements.get("minimax")).toHaveBeenCalledWith(expect.objectContaining({ status: "error", errorCode: "provider_rerouted" }))
    expect(settlements.get("anthropic")).toHaveBeenCalledOnce()
    expect(settlements.get("anthropic")).toHaveBeenCalledWith(expect.objectContaining({
      status: "success", inputTokens: 3, outputTokens: 4, estimatedCostUsd: expect.any(Number),
    }))
  })

  it("settles failed-route usage before rerouting and keeps its buffered output private", async () => {
    const order: string[] = [], settlements = new Map<string, ReturnType<typeof vi.fn>>()
    const fetcher: HarnessFetch = vi.fn(async url => {
      const provider = url.includes("anthropic") ? "anthropic" : "minimax"
      order.push(`fetch:${provider}`)
      return provider === "minimax" ? failedMinimaxStreamResponse() : fittingFallbackResponse()
    })
    const modelRuntime = harnessRuntime(fetcher, [5000, 5000])
    const authorize = vi.fn(async input => {
      order.push(`authorize:${input.provider}`)
      const settle = vi.fn(async () => { order.push(`settle:${input.provider}`) })
      settlements.set(input.provider, settle)
      return { settle, release: vi.fn() }
    })
    const wrapped = modelWithUsage(modelRuntime, lease, authorize)

    const events = await collect(wrapped.stream(request()))
    const minimaxCost = expectedCost("minimax", "MiniMax-M3", 29, 31)
    const anthropicCost = expectedCost("anthropic", "claude-sonnet-5", 3, 4)
    expect(events).toContainEqual({ type: "text_delta", text: "Fitting fallback" })
    expect(events).not.toContainEqual(expect.objectContaining({ type: "text_delta", text: "Primary partial text" }))
    expect(events.some(event => event.type.startsWith("tool_") && "callId" in event && event.callId === "primary-call")).toBe(false)
    expect(order).toEqual([
      "authorize:minimax", "fetch:minimax", "settle:minimax",
      "authorize:anthropic", "fetch:anthropic", "settle:anthropic",
    ])
    expect(settlements.get("minimax")).toHaveBeenCalledOnce()
    expect(settlements.get("minimax")).toHaveBeenCalledWith({
      status: "error", inputTokens: 29, outputTokens: 31, estimatedCostUsd: minimaxCost, errorCode: "provider_rerouted",
    })
    expect(settlements.get("anthropic")).toHaveBeenCalledOnce()
    expect(settlements.get("anthropic")).toHaveBeenCalledWith({
      status: "success", inputTokens: 3, outputTokens: 4, estimatedCostUsd: anthropicCost,
    })
    expect(minimaxCost).not.toBe(anthropicCost)
  })

  it("settles final Harness failure with observed usage exactly once", async () => {
    const settle = vi.fn(), release = vi.fn()
    const modelRuntime = harnessRuntime(vi.fn(async () => failedMinimaxStreamResponse()), [5000])
    const wrapped = modelWithUsage(modelRuntime, lease, async () => ({ settle, release }))

    await expect(collect(wrapped.stream(request()))).rejects.toMatchObject({ code: "provider_error" })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith({
      status: "error", inputTokens: 29, outputTokens: 31,
      estimatedCostUsd: expectedCost("minimax", "MiniMax-M3", 29, 31), errorCode: "provider_error",
    })
    expect(release).not.toHaveBeenCalled()
  })

  it("does not reroute a Harness stream when authorization fails", async () => {
    const diagnostics: string[] = [], fetcher = vi.fn(async () => { throw new Error("authorization reached fetch") })
    const runtime = harnessRuntime(fetcher, [5000, 5000], () => { diagnostics.push("preflight") })
    const authorize = vi.fn(async () => { throw new Error("usage_denied") })
    const wrapped = modelWithUsage(runtime, lease, authorize)

    await expect(collect(wrapped.stream(request()))).rejects.toMatchObject({ message: "usage_denied" })
    expect(authorize).toHaveBeenCalledOnce()
    expect(diagnostics).toEqual(["preflight"])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("settles a Harness provider error after authorization and never calls the provider first", async () => {
    const order: string[] = [], settlement = vi.fn(), release = vi.fn()
    const fetcher = vi.fn(async () => { order.push("fetch"); return new Response("unavailable", { status: 503 }) })
    const runtime = harnessRuntime(fetcher, [5000], () => { order.push("preflight") })
    const authorize = vi.fn(async () => { order.push("authorize"); return { settle: settlement, release } })
    const wrapped = modelWithUsage(runtime, lease, authorize)

    await expect(collect(wrapped.stream(request()))).rejects.toMatchObject({ code: "provider_error" })
    expect(order).toEqual(["preflight", "authorize", "fetch"])
    expect(settlement).toHaveBeenCalledOnce()
    expect(settlement).toHaveBeenCalledWith({ status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: "provider_error" })
    expect(release).not.toHaveBeenCalled()
  })

  it("releases the same authorization once when cancellation arrives during async authorization", async () => {
    const controller = new AbortController(), fetcher = vi.fn(async () => { throw new Error("cancelled request reached provider") })
    let beginAuthorization!: () => void, finishAuthorization!: (value: { settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) => void
    const authorizationStarted = new Promise<void>(resolve => { beginAuthorization = resolve })
    const authorization = new Promise<{ settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>(resolve => { finishAuthorization = resolve })
    const settlement = vi.fn(), release = vi.fn()
    const wrapped = modelWithUsage(harnessRuntime(fetcher, [5000]), lease, vi.fn(() => {
      beginAuthorization()
      return authorization
    }))
    const pending = collect(wrapped.stream({ ...request(), signal: controller.signal }))
    await authorizationStarted
    controller.abort(new Error("cancelled during authorization"))
    finishAuthorization({ settle: settlement, release })

    await expect(pending).rejects.toThrow("cancelled during authorization")
    expect(fetcher).not.toHaveBeenCalled()
    expect(settlement).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it("releases eager non-Harness authorization once when cancellation arrives during authorization", async () => {
    const controller = new AbortController(), provider = vi.fn(async function* () { yield { type: "completed", finishReason: "stop" } satisfies ModelStreamEvent })
    let beginAuthorization!: () => void, finishAuthorization!: (value: { settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) => void
    const authorizationStarted = new Promise<void>(resolve => { beginAuthorization = resolve })
    const authorization = new Promise<{ settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>(resolve => { finishAuthorization = resolve })
    const settlement = vi.fn(), release = vi.fn()
    const wrapped = modelWithUsage(runtime(adapter(provider)), lease, vi.fn(() => { beginAuthorization(); return authorization }))
    const pending = collect(wrapped.stream({ ...request(), signal: controller.signal }))
    await authorizationStarted
    controller.abort(new Error("cancelled during eager authorization"))
    finishAuthorization({ settle: settlement, release })

    await expect(pending).rejects.toThrow("cancelled during eager authorization")
    expect(provider).not.toHaveBeenCalled()
    expect(settlement).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
})
