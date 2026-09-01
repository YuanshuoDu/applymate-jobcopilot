import { describe, expect, it } from "vitest"
import type { ModelAdapter, ModelResponse } from "@jobcopilot/agent-model"

import { runModelStep } from "./turn-engine-model.js"

const request = {
  schemaVersion: "agent-harness.v2" as const,
  provider: "fixture",
  model: "fixture-model",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "continue" }] }],
  tools: [],
  capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false },
  signal: new AbortController().signal,
  metadata: { sessionId: "s", turnId: "t", stepId: "step", taskId: "task" },
}

function profile(nativeTools: boolean) {
  return {
    provider: "fixture", model: "fixture-model", nativeTools, structuredOutput: !nativeTools, streaming: true, continuationCursor: false,
    supportsParallelTools: nativeTools, supportsStreamingToolArgs: nativeTools, supportsReasoningSummary: true,
    supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
    maxContextTokens: null, maxOutputTokens: null, costClass: "unknown" as const,
  }
}

describe("TurnEngine model step normalization", () => {
  it("collects streamed commentary, reasoning, tool call, usage and completion", async () => {
    const adapter: ModelAdapter = {
      id: "fixture-native",
      profile: profile(true),
      async *stream() {
        yield { type: "reasoning_summary_delta", text: "Inspecting" }
        yield { type: "text_delta", text: "I will inspect." }
        yield { type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }
        yield { type: "usage", inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 }
        yield { type: "completed", finishReason: "tool_calls" }
      },
    }
    const result = await runModelStep(adapter, request)
    expect(result).toMatchObject({ text: "I will inspect.", reasoningSummary: "Inspecting", finishReason: "tool_calls" })
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }])
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it("normalizes the non-native structured fallback into a tool call", async () => {
    const response: ModelResponse = {
      schemaVersion: "agent-harness.v2", provider: "fixture", model: "fixture-model", finishReason: "stop", toolCalls: [], usage: null, continuationCursor: null,
      text: JSON.stringify({ schemaVersion: "agent-harness.v2", kind: "call_tool", callId: "call-1", tool: "jobs.search", arguments: {}, rationaleSummary: "Search" }),
    }
    const adapter: ModelAdapter = { id: "fixture-structured", profile: profile(false), stream: async function* () { yield { type: "completed", finishReason: "stop" } }, complete: async () => response }
    const result = await runModelStep(adapter, { ...request, capabilities: { ...request.capabilities, nativeTools: false } }, () => true)
    expect(result.toolCalls[0]).toMatchObject({ id: "call-1", name: "jobs.search" })
    expect(result.finishReason).toBe("tool_calls")
  })
})
