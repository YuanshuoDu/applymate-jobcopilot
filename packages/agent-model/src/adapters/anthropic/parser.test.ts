import { describe, expect, it } from "vitest"

import { AgentModelError } from "../../errors.js"
import { AnthropicMessagesParser } from "./parser.js"

function parse(events: Array<[string, unknown]>, parser = new AnthropicMessagesParser()) {
  return events.flatMap(([name, data]) => parser.consume(name, data).events)
}

describe("Anthropic Messages stream parser", () => {
  it("keeps tool calls ordered, joins fragmented JSON, maps names, and normalizes usage", () => {
    const parser = new AnthropicMessagesParser(new Map([
      ["jobs_x2e_search", "jobs.search"],
      ["jobs_x2e_get", "jobs.get"],
    ]))
    const events = parse([
      ["message_start", { type: "message_start", message: { type: "message", usage: { input_tokens: 11 } } }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_b", name: "jobs_x2e_get", input: {} } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_a", name: "jobs_x2e_search", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"id":"2"}' } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"' } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'Berlin"}' } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }],
      ["message_stop", { type: "message_stop" }],
    ], parser)

    expect(events.filter((event) => event.type === "tool_call_completed")).toEqual([
      { type: "tool_call_completed", callId: "call_a", name: "jobs.search", arguments: { q: "Berlin" } },
      { type: "tool_call_completed", callId: "call_b", name: "jobs.get", arguments: { id: "2" } },
    ])
    expect(events).toContainEqual({ type: "usage", inputTokens: 11, outputTokens: 7 })
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "tool_calls" })
  })

  it("emits text in order and never exposes private reasoning blocks", () => {
    const events = parse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "secret" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "do not show" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }],
    ])
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
    ])
    expect(events.some((event) => event.type === "reasoning_summary_delta")).toBe(false)
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "stop" })
  })

  it("fails typed on malformed blocks, truncated arguments, and missing terminal events", () => {
    const missingStart = new AnthropicMessagesParser()
    expect(() => missingStart.consume("content_block_delta", {
      index: 0, delta: { type: "text_delta", text: "hello" },
    })).toThrowError(AgentModelError)

    const truncated = new AnthropicMessagesParser()
    truncated.consume("content_block_start", {
      index: 0, content_block: { type: "tool_use", id: "call_1", name: "jobs_search", input: {} },
    })
    truncated.consume("content_block_delta", {
      index: 0, delta: { type: "input_json_delta", partial_json: "{" },
    })
    truncated.consume("message_delta", { delta: { stop_reason: "tool_use" } })
    expect(() => truncated.consume("message_stop", { type: "message_stop" })).toThrowError(AgentModelError)

    const incomplete = new AnthropicMessagesParser()
    incomplete.consume("message_start", { message: { usage: { input_tokens: 1 } } })
    expect(() => incomplete.finish()).toThrowError(/message_stop/)
  })
})
