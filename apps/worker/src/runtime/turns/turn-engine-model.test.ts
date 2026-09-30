import { describe, expect, it } from "vitest"
import type { ModelAdapter, ModelResponse } from "@jobcopilot/agent-model"

import { runModelStep } from "./turn-engine-model.js"
import { TurnEngineError } from "./turn-engine-types.js"

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
    const result = await runModelStep(adapter, request, () => true)
    expect(result).toMatchObject({ text: "I will inspect.", reasoningSummary: "Inspecting", finishReason: "tool_calls" })
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }])
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it("classifies a stream without a finish reason as invalid output", async () => {
    const adapter: ModelAdapter = {
      id: "fixture-native-incomplete",
      profile: profile(true),
      async *stream() {
        yield { type: "text_delta", text: "Incomplete" }
      },
    }

    const result = runModelStep(adapter, request)
    await expect(result).rejects.toBeInstanceOf(TurnEngineError)
    await expect(result).rejects.toMatchObject({ code: "invalid_output", message: "Model stream completed without a finish reason" })

    const trailing: ModelAdapter = {
      id: "fixture-native-trailing-event",
      profile: profile(true),
      async *stream() {
        yield { type: "completed", finishReason: "stop" }
        yield { type: "text_delta", text: "after completion" }
      },
    }
    await expect(runModelStep(trailing, request)).rejects.toMatchObject({ code: "invalid_output", message: "Model stream emitted data after completion" })
  })

  it.each([
    { label: "tool calls with a stop finish", events: [{ type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: {} }, { type: "completed", finishReason: "stop" }] },
    { label: "tool calls with an error finish", events: [{ type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: {} }, { type: "completed", finishReason: "error" }] },
    { label: "a tool finish without calls", events: [{ type: "completed", finishReason: "tool_calls" }] },
  ] as const)("fails closed for $label", async ({ events }) => {
    const adapter: ModelAdapter = { id: "fixture-native-invalid-finish", profile: profile(true), async *stream() { yield* events } }
    await expect(runModelStep(adapter, request)).rejects.toMatchObject({ code: "invalid_output" })
  })

  it("fails closed for duplicate native tool call ids and invalid native arguments", async () => {
    const duplicate: ModelAdapter = {
      id: "fixture-native-duplicate-call", profile: profile(true), async *stream() {
        yield { type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: {} }
        yield { type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }
        yield { type: "completed", finishReason: "tool_calls" }
      },
    }
    await expect(runModelStep(duplicate, request, () => true)).rejects.toMatchObject({ code: "invalid_output", message: "Model stream repeated a tool call id" })

    const invalidArguments: ModelAdapter = {
      id: "fixture-native-invalid-arguments", profile: profile(true), async *stream() {
        yield { type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: {} }
        yield { type: "completed", finishReason: "tool_calls" }
      },
    }
    await expect(runModelStep(invalidArguments, request, () => "schema_error")).rejects.toMatchObject({ code: "invalid_output", message: "schema_error" })

    const missingValidator: ModelAdapter = {
      id: "fixture-native-missing-validator", profile: profile(true), async *stream() {
        yield { type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: {} }
        yield { type: "completed", finishReason: "tool_calls" }
      },
    }
    await expect(runModelStep(missingValidator, request)).rejects.toMatchObject({ code: "invalid_output", message: "A tool arguments validator is required before execution" })
  })

  it("fails closed when structured output reports a non-success finish", async () => {
    const response: ModelResponse = {
      schemaVersion: "agent-harness.v2", provider: "fixture", model: "fixture-model", finishReason: "error", toolCalls: [], usage: null, continuationCursor: null,
      text: JSON.stringify({ schemaVersion: "agent-harness.v2", kind: "finish", response: { text: "done" } }),
    }
    const adapter: ModelAdapter = { id: "fixture-structured-error", profile: profile(false), stream: async function* () { yield { type: "completed", finishReason: "stop" } }, complete: async () => response }
    await expect(runModelStep(adapter, { ...request, capabilities: { ...request.capabilities, nativeTools: false } })).rejects.toMatchObject({ code: "invalid_output", message: "Structured model response did not complete normally" })
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
