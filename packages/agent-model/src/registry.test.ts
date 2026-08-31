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

function adapter(id: string, model = profile.model): ModelAdapter {
  return {
    id,
    profile: { ...profile, model },
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
})
