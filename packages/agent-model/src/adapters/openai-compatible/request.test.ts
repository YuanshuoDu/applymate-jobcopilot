import { describe, expect, it } from "vitest"

import { AgentModelError } from "../../errors.js"
import { MODEL_SCHEMA_VERSION, type HarnessModelRequest } from "../../contracts.js"
import { buildOpenAiRequest } from "./request.js"

const config = { provider: "openai-compatible", model: "gpt-test", baseUrl: "https://api.example.com/v1", apiKey: "secret" }

function request(overrides: Partial<HarnessModelRequest> = {}): HarnessModelRequest {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: config.provider,
    model: config.model,
    messages: [{ role: "user", content: [{ type: "text", text: "Find Berlin jobs" }] }],
    tools: [{ name: "jobs.search", description: "Search jobs", inputSchema: { type: "object" } }],
    capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false },
    signal: new AbortController().signal,
    metadata: { sessionId: "s1", turnId: "t1", stepId: "p1", taskId: "k1" },
    ...overrides,
  }
}

describe("OpenAI-compatible request builder", () => {
  it("builds a Chat Completions streaming request without putting the API key in the body", () => {
    const result = buildOpenAiRequest(request({ outputSchema: { type: "object" } }), config)
    expect(result.url).toBe("https://api.example.com/v1/chat/completions")
    expect(result.headers).toMatchObject({ Authorization: "Bearer secret", Accept: "text/event-stream" })
    expect(result.body).toMatchObject({ model: "gpt-test", stream: true })
    expect(result.body).not.toHaveProperty("max_tokens")
    expect(result.body).not.toHaveProperty("apiKey")
    expect(result.body.response_format).toEqual({
      type: "json_schema", json_schema: { name: "harness_output", schema: { type: "object" }, strict: true },
    })
  })

  it("builds Responses continuation and maps tool choice to Responses syntax", () => {
    const result = buildOpenAiRequest(request({
      toolChoice: { name: "jobs.search" },
      continuation: { providerResponseId: "resp_1", providerConversationId: "conv_1" },
    }), config, { mode: "responses" })
    expect(result.url).toBe("https://api.example.com/v1/responses")
    expect(result.body).toMatchObject({ previous_response_id: "resp_1", conversation: "conv_1", tool_choice: { type: "function", name: "jobs.search" } })
    expect(result.body.tools).toEqual([{ type: "function", name: "jobs.search", description: "Search jobs", parameters: { type: "object" } }])
    expect(result.body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Find Berlin jobs" }] }])
  })

  it("rejects unsafe endpoints and unsupported Chat Completions continuation", () => {
    expect(() => buildOpenAiRequest(request(), { ...config, baseUrl: "http://127.0.0.1:8080/v1" })).toThrow(AgentModelError)
    expect(() => buildOpenAiRequest(request(), { ...config, baseUrl: "https://metadata.google.internal/v1" })).toThrow(AgentModelError)
    expect(() => buildOpenAiRequest(request(), { ...config, baseUrl: "https://api.example.com/v1?redirect=http://127.0.0.1" })).toThrow(AgentModelError)
    expect(() => buildOpenAiRequest(request({ continuation: { providerResponseId: "resp_1" } }), config)).toThrowError(/does not support provider continuation/)
  })
})
