import { describe, expect, it, vi } from "vitest"
import {
  MODEL_SCHEMA_VERSION,
  type HarnessModelRequest,
  type ModelAdapter,
  type ModelCapabilityProfile,
  type ModelResponse,
  type ModelStreamEvent,
} from "@jobcopilot/agent-model"
import type { HarnessModelRuntime } from "./harness-model.js"
import { defaultAuthorization, modelWithUsage } from "./canonical-turn-runtime-model.js"
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

describe("canonical turn runtime usage model", () => {
  it("authorizes against the lease identity, autoApply feature, adapter route, and request step", async () => {
    const events = [{ type: "completed", finishReason: "stop" } satisfies ModelStreamEvent]
    const authorize = vi.fn(async () => ({ settle: vi.fn() }))
    const wrapped = modelWithUsage(runtime(adapter(async function* () { yield* events })), lease, authorize)

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
})
