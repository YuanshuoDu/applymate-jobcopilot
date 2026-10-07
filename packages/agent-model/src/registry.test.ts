import { describe, expect, it } from "vitest"

import { AgentModelError } from "./errors.js"
import { ModelAdapterRegistry } from "./registry.js"
import type { ModelAdapter } from "./contracts.js"

const profile = {
  provider: "openai-compatible", model: "test-model", nativeTools: true, structuredOutput: true,
  streaming: true, continuationCursor: false, supportsParallelTools: true, supportsStreamingToolArgs: true,
  supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: 128_000, maxOutputTokens: 4_096, costClass: "low" as const,
}

function adapter(id: string, model = profile.model, overrides: Partial<ModelAdapter["profile"]> = {}): ModelAdapter {
  return {
    id,
    profile: { ...profile, ...overrides, model },
    async *stream() { yield { type: "completed", finishReason: "stop" } },
  }
}

describe("ModelAdapterRegistry", () => {
  it("resolves an exact model before a provider wildcard", () => {
    const registry = new ModelAdapterRegistry()
    registry.register(adapter("wildcard", "*"))
    registry.register(adapter("exact"))
    expect(registry.resolve({ provider: profile.provider, model: profile.model }).id).toBe("exact")
  })

  it("rejects duplicate ids and unmet capability requirements", () => {
    const registry = new ModelAdapterRegistry()
    registry.register(adapter("test"))
    expect(() => registry.register(adapter("test"))).toThrow(AgentModelError)
    expect(() => registry.resolve({ provider: profile.provider, model: profile.model }, { nativeTools: false })).not.toThrow()
    expect(() => registry.resolve({ provider: profile.provider, model: profile.model }, { supportsReasoningSummary: true })).toThrow("supportsReasoningSummary")
  })

  it("returns a typed recoverable error for an unknown target", () => {
    expect(() => new ModelAdapterRegistry().resolve({ provider: "missing", model: "model" })).toThrow("No model adapter")
  })

  it("accepts legacy, null, and compatible default output metadata without changing capability maxima", () => {
    const registry = new ModelAdapterRegistry()
    registry.register(adapter("legacy"))
    registry.register(adapter("null-default", profile.model, { defaultMaxOutputTokens: null }))
    registry.register(adapter("bounded-default", profile.model, { defaultMaxOutputTokens: 1_024 }))

    expect(registry.get("legacy")?.profile.defaultMaxOutputTokens).toBeUndefined()
    expect(registry.get("null-default")?.profile.defaultMaxOutputTokens).toBeNull()
    expect(registry.get("bounded-default")?.profile).toMatchObject({
      maxOutputTokens: 4_096,
      defaultMaxOutputTokens: 1_024,
    })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid default output limit %s", limit => {
    expect(() => new ModelAdapterRegistry().register(adapter("invalid-default", profile.model, {
      defaultMaxOutputTokens: limit,
    }))).toThrow(AgentModelError)
  })

  it("rejects a default output limit above a known capability maximum or context window", () => {
    const registry = new ModelAdapterRegistry()
    expect(() => registry.register(adapter("above-output-max", profile.model, {
      defaultMaxOutputTokens: profile.maxOutputTokens + 1,
    }))).toThrow(AgentModelError)
    expect(() => registry.register(adapter("above-context-window", profile.model, {
      maxOutputTokens: 200_000,
      defaultMaxOutputTokens: profile.maxContextTokens + 1,
    }))).toThrow(AgentModelError)
  })
})
