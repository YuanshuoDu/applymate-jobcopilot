import { describe, expect, it } from "vitest"

import { AgentModelError } from "../../errors.js"
import { MODEL_SCHEMA_VERSION, type HarnessModelRequest } from "../../contracts.js"
import { buildAnthropicRequest } from "./request.js"

const config = { provider: "anthropic", model: "claude-test", baseUrl: "https://api.anthropic.com", apiKey: "secret" }

function request(overrides: Partial<HarnessModelRequest> = {}): HarnessModelRequest {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: config.provider,
    model: config.model,
    messages: [
      { role: "system", content: [{ type: "text", text: "You are a job assistant" }] },
      { role: "user", content: [{ type: "text", text: "Find Berlin jobs" }] },
    ],
    tools: [{ name: "jobs.search", description: "Search jobs", inputSchema: { type: "object" } }],
    capabilities: { nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false },
    signal: new AbortController().signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "p1", taskId: "k1" },
    ...overrides,
  }
}

describe("Anthropic request mapper", () => {
  it("maps system messages, tools, tool choice, and required streaming headers", () => {
    const result = buildAnthropicRequest(request({ toolChoice: { name: "jobs.search" } }), config)
    expect(result.url).toBe("https://api.anthropic.com/v1/messages")
    expect(result.headers).toMatchObject({
      Accept: "text/event-stream",
      "anthropic-version": "2023-06-01",
      "x-api-key": "secret",
    })
    expect(result.body).toMatchObject({ model: "claude-test", max_tokens: 1_024, stream: true })
    expect(result.body).not.toHaveProperty("apiKey")
    expect(result.body.system).toBe("You are a job assistant")
    expect(result.body.tools).toEqual([{
      name: "jobs_x2e_search",
      description: "Search jobs",
      input_schema: { type: "object" },
    }])
    expect(result.body.tool_choice).toEqual({ type: "tool", name: "jobs_x2e_search" })
    expect(result.toolNameMap.get("jobs_x2e_search")).toBe("jobs.search")
  })

  it("preserves tool-result correlation and places results before text", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Search" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "jobs.search", input: { q: "Berlin" } }] },
      { role: "tool", content: [
        { type: "text", text: "follow-up" },
        { type: "tool_result", toolUseId: "call_1", content: "two jobs" },
      ] },
    ] as unknown as HarnessModelRequest["messages"]
    const result = buildAnthropicRequest(request({ messages }), config)
    expect(result.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Search" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "jobs_x2e_search", input: { q: "Berlin" } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_1", content: "two jobs" },
        { type: "text", text: "follow-up" },
      ] },
    ])
  })

  it("fails closed for unsafe endpoints, continuation, and unsupported input", () => {
    expect(() => buildAnthropicRequest(request(), { ...config, baseUrl: "http://127.0.0.1:8080" })).toThrow(AgentModelError)
    expect(() => buildAnthropicRequest(request({ continuation: { providerResponseId: "msg_1" } }), config)).toThrowError(/continuation/)
    expect(() => buildAnthropicRequest(request({ outputSchema: { type: "object" } }), config)).toThrowError(/structured output/)
    expect(() => buildAnthropicRequest(request({
      messages: [{ role: "user", content: [{ type: "attachment_ref", attachmentId: "a1", mediaType: "application/pdf" }] }],
    }), config)).toThrowError(/attachment/)
  })
})
