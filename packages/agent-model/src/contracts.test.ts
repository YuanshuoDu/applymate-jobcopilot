import { describe, expect, it } from "vitest"

import { MODEL_SCHEMA_VERSION, type HarnessModelRequest, type ModelStreamEvent } from "./contracts.js"

describe("agent model contracts", () => {
  it("requires the full Session to Task attribution metadata", () => {
    const request: HarnessModelRequest = {
      schemaVersion: MODEL_SCHEMA_VERSION,
      provider: "openai-compatible",
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "Find EU jobs" }] }],
      tools: [],
      capabilities: { nativeTools: false, structuredOutput: true, streaming: true, continuationCursor: false },
      signal: new AbortController().signal,
      metadata: { sessionId: "session_1", turnId: "turn_1", stepId: "step_1", taskId: "task_root" },
    }
    expect(request.metadata).toEqual({ sessionId: "session_1", turnId: "turn_1", stepId: "step_1", taskId: "task_root" })
  })

  it("normalizes streaming text, tools, usage, continuation, and completion events", () => {
    const events: ModelStreamEvent[] = [
      { type: "text_delta", text: "Found " },
      { type: "tool_call_started", callId: "call_1", name: "jobs.search" },
      { type: "tool_arguments_delta", callId: "call_1", delta: "{\"location\":\"Berlin\"}" },
      { type: "tool_call_completed", callId: "call_1", name: "jobs.search", arguments: { location: "Berlin" } },
      { type: "usage", inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
      { type: "continuation", continuation: { cursor: "provider_cursor" } },
      { type: "completed", finishReason: "tool_calls" },
    ]
    expect(events.map((event) => event.type)).toEqual([
      "text_delta", "tool_call_started", "tool_arguments_delta", "tool_call_completed",
      "usage", "continuation", "completed",
    ])
  })
})
