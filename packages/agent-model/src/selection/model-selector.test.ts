import { describe, expect, it, vi } from "vitest"

import { AgentModelError } from "../errors.js"
import type { ModelAdapter } from "../contracts.js"
import { ModelAdapterRegistry } from "../registry.js"
import {
  executeWithModelFallback,
  MAX_MODEL_REROUTES,
  type ModelSelectionEvent,
} from "./model-selector.js"

const profile = {
  provider: "openai-compatible", model: "test-model", nativeTools: true, structuredOutput: true,
  streaming: true, continuationCursor: false, supportsParallelTools: true, supportsStreamingToolArgs: true,
  supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: 128_000, maxOutputTokens: 4_096, costClass: "low" as const,
}

function adapter(id: string, provider: string, model: string): ModelAdapter {
  return {
    id,
    profile: {
      ...profile,
      provider,
      model,
      nativeTools: provider !== "minimax",
      structuredOutput: provider !== "minimax",
    },
    async *stream() { yield { type: "completed", finishReason: "stop" } },
  }
}

function registry(): ModelAdapterRegistry {
  return new ModelAdapterRegistry()
    .register(adapter("mini", "minimax", "MiniMax-M3"))
    .register(adapter("anthropic", "anthropic", "claude-test"))
    .register(adapter("openai", "openai-compatible", "gpt-test"))
}

describe("capability-aware model fallback", () => {
  it("reroutes a retryable 429/5xx-style failure and records attempt, reroute, and usage", async () => {
    const events: ModelSelectionEvent[] = []
    const invoke = vi.fn()
      .mockRejectedValueOnce(new AgentModelError({ code: "provider_error", message: "HTTP 429", retryable: true, recoverable: true }))
      .mockResolvedValueOnce({ value: "done", usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 } })
    const result = await executeWithModelFallback(registry(), [
      { target: { provider: "minimax", model: "MiniMax-M3" }, reason: "default" },
      { target: { provider: "anthropic", model: "claude-test" }, reason: "tool-capable fallback" },
    ], invoke, { onEvent: event => events.push(event) })
    expect(result.value).toBe("done")
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual(expect.objectContaining({ type: "model.rerouted", from: { provider: "minimax", model: "MiniMax-M3" }, to: { provider: "anthropic", model: "claude-test" } }))
    expect(events).toContainEqual(expect.objectContaining({ type: "model.usage", usage: expect.objectContaining({ inputTokens: 10 }) }))
    expect(events.filter(event => event.type === "model.attempt")).toHaveLength(4)
  })

  it("uses capability requirements to skip an incompatible route", async () => {
    const invoke = vi.fn().mockResolvedValue({ value: "anthropic" })
    const result = await executeWithModelFallback(registry(), [
      { target: { provider: "minimax", model: "MiniMax-M3" }, requirement: { nativeTools: true } },
      { target: { provider: "anthropic", model: "claude-test" }, requirement: { nativeTools: true } },
    ], invoke)
    expect(result.adapter.id).toBe("anthropic")
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("never reroutes after an irreversible action has started", async () => {
    const invoke = vi.fn().mockRejectedValue(new AgentModelError({ code: "provider_error", message: "HTTP 503", retryable: true, recoverable: true }))
    const events: ModelSelectionEvent[] = []
    await expect(executeWithModelFallback(registry(), [
      { target: { provider: "minimax", model: "MiniMax-M3" } },
      { target: { provider: "anthropic", model: "claude-test" } },
    ], invoke, { irreversibleActionStarted: true, onEvent: event => events.push(event) })).rejects.toMatchObject({ code: "provider_error" })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(events).not.toContainEqual(expect.objectContaining({ type: "model.rerouted" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "model.attempt", status: "failed", rerouteBlocked: true }))
  })

  it("fails closed if the irreversible-action state cannot be read", async () => {
    const invoke = vi.fn().mockRejectedValue(new AgentModelError({ code: "provider_error", message: "HTTP 503", retryable: true, recoverable: true }))
    await expect(executeWithModelFallback(registry(), [
      { target: { provider: "minimax", model: "MiniMax-M3" } },
      { target: { provider: "anthropic", model: "claude-test" } },
    ], invoke, { irreversibleActionStarted: () => { throw new Error("state unavailable") } })).rejects.toMatchObject({ code: "provider_error" })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("bounds route changes and keeps the original typed failure when exhausted", async () => {
    const invoke = vi.fn().mockRejectedValue(new AgentModelError({ code: "provider_error", message: "HTTP 500", retryable: true, recoverable: true }))
    const candidates = [
      { target: { provider: "minimax", model: "MiniMax-M3" } },
      { target: { provider: "anthropic", model: "claude-test" } },
      { target: { provider: "openai-compatible", model: "gpt-test" } },
      { target: { provider: "openai-compatible", model: "unused" } },
    ]
    await expect(executeWithModelFallback(registry(), candidates, invoke)).rejects.toMatchObject({ message: "HTTP 500" })
    expect(invoke).toHaveBeenCalledTimes(MAX_MODEL_REROUTES + 1)
  })

  it("allows a cursor-loss failure to move to a route that can continue from rebuilt context", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new AgentModelError({ code: "cursor_lost", message: "cursor expired", recoverable: true }))
      .mockResolvedValueOnce({ value: "recovered" })
    await expect(executeWithModelFallback(registry(), [
      { target: { provider: "openai-compatible", model: "gpt-test" } },
      { target: { provider: "minimax", model: "MiniMax-M3" } },
    ], invoke)).resolves.toMatchObject({ value: "recovered", attempt: 2 })
  })
})
