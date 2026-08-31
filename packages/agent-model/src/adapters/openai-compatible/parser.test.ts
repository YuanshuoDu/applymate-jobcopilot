import { describe, expect, it } from "vitest"

import { AgentModelError } from "../../errors.js"
import { ChatCompletionsParser, ResponsesParser } from "./parser.js"

describe("OpenAI-compatible stream parsers", () => {
  it("normalizes Chat Completions text, usage, and multiple ordered tool calls", () => {
    const parser = new ChatCompletionsParser()
    const events = [
      ...parser.consume(undefined, { choices: [{ delta: { content: "Found " } }] }).events,
      ...parser.consume(undefined, { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "jobs.get", arguments: '{"id":"2"}' } }] } }] }).events,
      ...parser.consume(undefined, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "jobs.search", arguments: '{"q":"' } }] } }] }).events,
      ...parser.consume(undefined, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Berlin"}' } }] }, finish_reason: "tool_calls" }] }).events,
      ...parser.consume(undefined, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 7 } }).events,
      ...parser.finish(),
    ]
    expect(events).toContainEqual({ type: "text_delta", text: "Found " })
    expect(events).toContainEqual({ type: "usage", inputTokens: 9, outputTokens: 7 })
    expect(events.filter((event) => event.type === "tool_call_completed")).toEqual([
      { type: "tool_call_completed", callId: "call_a", name: "jobs.search", arguments: { q: "Berlin" } },
      { type: "tool_call_completed", callId: "call_b", name: "jobs.get", arguments: { id: "2" } },
    ])
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "tool_calls" })
  })

  it("normalizes Responses output text, function arguments, continuation, and usage", () => {
    const parser = new ResponsesParser()
    const events = [
      ...parser.consume("response.output_text.delta", { delta: "Hello" }).events,
      ...parser.consume("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "item_1", call_id: "call_1", name: "jobs.search", arguments: "" } }).events,
      ...parser.consume("response.function_call_arguments.delta", { item_id: "item_1", delta: '{"q":"Dublin"' }).events,
      ...parser.consume("response.function_call_arguments.done", { item_id: "item_1", arguments: '{"q":"Dublin"}' }).events,
      ...parser.consume("response.output_item.done", { output_index: 0, item: { type: "function_call", id: "item_1", call_id: "call_1", name: "jobs.search", arguments: '{"q":"Dublin"}' } }).events,
      ...parser.consume("response.completed", { response: { id: "resp_1", conversation_id: "conv_1", usage: { input_tokens: 4, output_tokens: 3 } } }).events,
    ]
    expect(events).toContainEqual({ type: "text_delta", text: "Hello" })
    expect(events).toContainEqual({ type: "continuation", continuation: { cursor: "resp_1", providerResponseId: "resp_1", providerConversationId: "conv_1" } })
    expect(events).toContainEqual({ type: "tool_call_completed", callId: "call_1", name: "jobs.search", arguments: { q: "Dublin" } })
    expect(events).toContainEqual({ type: "usage", inputTokens: 4, outputTokens: 3 })
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "tool_calls" })
  })

  it("fails typed on malformed JSON and missing Responses cursor", () => {
    const chat = new ChatCompletionsParser()
    chat.consume(undefined, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "jobs.search", arguments: "{" } }] }, finish_reason: "tool_calls" }] })
    expect(() => chat.finish()).toThrowError(AgentModelError)
    const responses = new ResponsesParser()
    expect(() => responses.consume("response.completed", { response: { usage: { input_tokens: 1, output_tokens: 1 } } })).toThrowError(/response id/)
  })

  it("rejects non-string argument fragments instead of treating them as empty arguments", () => {
    const parser = new ChatCompletionsParser()
    expect(() => parser.consume(undefined, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "jobs.search", arguments: 42 } }] } }],
    })).toThrowError(/non-string tool argument/)
  })
})
