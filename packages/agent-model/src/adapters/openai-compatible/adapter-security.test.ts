import { describe, expect, it, vi } from "vitest"

import { MODEL_SCHEMA_VERSION, type HarnessModelRequest } from "../../contracts.js"
import { capabilityProfile } from "./request.js"

const { pinnedFetch } = vi.hoisted(() => ({ pinnedFetch: vi.fn() }))

vi.mock("@jobcopilot/shared/pinned-outbound", () => ({ pinnedFetch }))

import { createOpenAiCompatibleAdapter } from "./adapter.js"

function request(): HarnessModelRequest {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: "openai-compatible",
    model: "gpt-test",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    capabilities: capabilityProfile({ provider: "openai-compatible", model: "gpt-test" }, "chat_completions"),
    signal: new AbortController().signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "p1", taskId: "k1" },
  }
}

describe("OpenAI-compatible outbound security boundary", () => {
  it("routes the default transport through DNS-pinned outbound fetch", async () => {
    pinnedFetch.mockResolvedValueOnce(new Response(
      "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ))
    const adapter = createOpenAiCompatibleAdapter({
      provider: "openai-compatible", model: "gpt-test", baseUrl: "https://api.example.com/v1", apiKey: "secret",
    })
    const events: unknown[] = []
    for await (const event of adapter.stream(request())) events.push(event)
    expect(events).toContainEqual({ type: "completed", finishReason: "stop" })
    expect(pinnedFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({ allowLocalDevelopment: false, signal: expect.any(AbortSignal) }),
    )
  })
})
