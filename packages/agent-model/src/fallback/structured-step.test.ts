import { describe, expect, it, vi } from "vitest"

import { MODEL_SCHEMA_VERSION, type HarnessModelRequest, type ModelAdapter } from "../contracts.js"
import { completeStructuredStep } from "./structured-step.js"

const request: HarnessModelRequest = {
  schemaVersion: MODEL_SCHEMA_VERSION,
  provider: "minimax",
  model: "MiniMax-M3",
  messages: [{ role: "user", content: [{ type: "text", text: "Search" }] }],
  tools: [{ name: "jobs.search" }],
  capabilities: { nativeTools: false, structuredOutput: false, streaming: true, continuationCursor: false },
  signal: new AbortController().signal,
  metadata: { sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "task-1" },
}

const callText = JSON.stringify({
  schemaVersion: "agent-harness.v2", kind: "call_tool", callId: "call-1", tool: "jobs.search",
  arguments: { query: "backend" }, rationaleSummary: "Search jobs.",
})

function adapterWithComplete(responseText: string): ModelAdapter {
  return {
    id: "test",
    profile: {
      provider: request.provider, model: request.model, nativeTools: false, structuredOutput: false,
      streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 4_096, costClass: "low",
    },
    async *stream() { yield { type: "completed", finishReason: "stop" } },
    complete: vi.fn().mockResolvedValue({
      schemaVersion: MODEL_SCHEMA_VERSION, provider: request.provider, model: request.model,
      finishReason: "stop", text: responseText, toolCalls: [], usage: null, continuationCursor: null,
    }),
  }
}

describe("structured model step execution", () => {
  it("only returns a validated text tool intent as a normalized tool call", async () => {
    const adapter = adapterWithComplete(callText)
    const result = await completeStructuredStep(adapter, request, { validateToolArguments: () => true })
    expect(result.step).toMatchObject({ kind: "call_tool", tool: "jobs.search" })
    expect(result.response).toMatchObject({ finishReason: "tool_calls", toolCalls: [{ id: "call-1", name: "jobs.search" }] })
    expect(adapter.complete).toHaveBeenCalledWith(request)
  })

  it("buffers a text stream before validation and preserves usage/cursor metadata", async () => {
    const adapter = adapterWithComplete("")
    adapter.complete = undefined
    adapter.stream = async function* () {
      yield { type: "text_delta" as const, text: callText.slice(0, 18) }
      yield { type: "text_delta" as const, text: callText.slice(18) }
      yield { type: "usage" as const, inputTokens: 3, outputTokens: 4, estimatedCostUsd: 0.02 }
      yield { type: "continuation" as const, continuation: { cursor: "cursor-1" } }
      yield { type: "completed" as const, finishReason: "stop" as const }
    }
    const result = await completeStructuredStep(adapter, request, { validateToolArguments: () => true })
    expect(result.response).toMatchObject({ usage: { inputTokens: 3, outputTokens: 4 }, continuationCursor: "cursor-1" })
  })

  it("does not accept invalid text output even when the provider call succeeded", async () => {
    await expect(completeStructuredStep(adapterWithComplete("ACTION:submit"), request)).rejects.toMatchObject({
      name: "NextStepValidationError", repairAttempts: 0,
    })
  })

  it("refuses to produce an executable tool call without a tool schema validator", async () => {
    await expect(completeStructuredStep(adapterWithComplete(callText), request)).rejects.toMatchObject({
      name: "NextStepValidationError", issues: [expect.objectContaining({ keyword: "toolArguments" })],
    })
  })
})
