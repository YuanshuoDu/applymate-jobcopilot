import { describe, expect, it, vi } from "vitest"

import { MODEL_SCHEMA_VERSION, type ModelCapabilityProfile } from "./contracts.js"
import { AgentModelError } from "./errors.js"
import { createLegacyModelFacade } from "./compatibility.js"

const profile: ModelCapabilityProfile = {
  provider: "legacy", model: "legacy-model", nativeTools: false, structuredOutput: false,
  streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
  supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 4_096, costClass: "unknown",
}

function request(signal = new AbortController().signal) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION, provider: "legacy", model: "legacy-model",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Find jobs" }] }],
    tools: [], capabilities: { nativeTools: false, structuredOutput: false, streaming: true, continuationCursor: false },
    signal, metadata: { sessionId: "session_1", turnId: "turn_1", stepId: "step_1", taskId: "task_1" },
  }
}

describe("legacy model compatibility facade", () => {
  it("keeps the legacy chat result unchanged and normalizes a stream", async () => {
    const result = { text: "Berlin jobs", inputTokens: 10, outputTokens: 5, provider: "legacy", model: "legacy-model" }
    const chat = vi.fn().mockResolvedValue(result)
    const client = createLegacyModelFacade({
      chat,
      async *stream() { yield "Berlin "; yield "jobs" },
    })
    const config = { apiKey: "server-side-only" }
    await expect(client.chat([{ role: "user", content: "Find jobs" }], config, 900)).resolves.toBe(result)
    const adapter = client.createAdapter(config, profile)
    const events = []
    for await (const event of adapter.stream(request())) events.push(event)
    expect(events).toEqual([{ type: "text_delta", text: "Berlin " }, { type: "text_delta", text: "jobs" }, { type: "completed", finishReason: "stop" }])
    expect(chat).toHaveBeenCalledWith([{ role: "user", content: "Find jobs" }], config, 900, undefined)
  })

  it("uses the non-streaming legacy result when shared LLM has no stream API", async () => {
    const client = createLegacyModelFacade({
      chat: vi.fn().mockResolvedValue({ text: "done", inputTokens: 2, outputTokens: 1, provider: "legacy", model: "legacy-model" }),
    })
    const response = await client.createAdapter({}, profile).complete?.(request())
    expect(response).toMatchObject({ schemaVersion: MODEL_SCHEMA_VERSION, text: "done", finishReason: "stop", toolCalls: [] })
    expect(response?.usage).toEqual({ inputTokens: 2, outputTokens: 1, estimatedCostUsd: 0 })
  })

  it("does not invent a missing token count in the normalized response", async () => {
    const client = createLegacyModelFacade({
      chat: vi.fn().mockResolvedValue({ text: "done", inputTokens: 2, provider: "legacy", model: "legacy-model" }),
    })
    const response = await client.createAdapter({}, profile).complete?.(request())
    expect(response?.usage).toBeNull()
  })

  it("fails before calling legacy code for tool messages or an aborted request", async () => {
    const chat = vi.fn()
    const client = createLegacyModelFacade({ chat: chat.mockResolvedValue({ text: "no", provider: "legacy", model: "legacy-model" }) })
    const adapter = client.createAdapter({}, profile)
    const aborted = new AbortController()
    aborted.abort()
    await expect(adapter.complete?.(request(aborted.signal))).rejects.toMatchObject({ code: "cancelled" })
    await expect(adapter.complete?.({ ...request(), messages: [{ role: "tool", content: [{ type: "text", text: "result" }] }] })).rejects.toBeInstanceOf(AgentModelError)
    expect(chat).not.toHaveBeenCalled()
  })

  it("preserves the host runtime when adapting usage context", async () => {
    const chat = vi.fn().mockResolvedValue({ text: "done", provider: "legacy", model: "legacy-model" })
    const client = createLegacyModelFacade({ chat }, { runtime: "web" })
    await client.createAdapter({}, profile).complete?.(request())
    expect(chat).toHaveBeenCalledWith(expect.any(Array), {}, 1_024, {
      userId: undefined, featureKey: undefined, runtime: "web",
    })
  })
})
