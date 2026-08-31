import { describe, expect, it } from "vitest"

import { AgentModelError } from "../../errors.js"
import { ToolCallAccumulator } from "./tool-aggregation.js"

describe("ToolCallAccumulator", () => {
  it("emits ordered calls with stable ids after fragmented arguments", () => {
    const accumulator = new ToolCallAccumulator()
    const events = [
      ...accumulator.accept(1, { callId: "call_b", name: "jobs.get" }, '{"id":"b"'),
      ...accumulator.accept(0, { callId: "call_a", name: "jobs.search" }, '{"q":"'),
      ...accumulator.accept(0, {}, "Berlin\"}"),
      ...accumulator.accept(1, {}, "}"),
      ...accumulator.complete("tool_calls"),
    ]
    expect(events.filter((event) => event.type === "tool_call_completed")).toEqual([
      { type: "tool_call_completed", callId: "call_a", name: "jobs.search", arguments: { q: "Berlin" } },
      { type: "tool_call_completed", callId: "call_b", name: "jobs.get", arguments: { id: "b" } },
    ])
  })

  it("fails closed on truncated arguments and never emits completion", () => {
    const accumulator = new ToolCallAccumulator()
    accumulator.accept(0, { callId: "call_1", name: "jobs.search" }, '{"q":"Berlin"')
    expect(() => accumulator.complete("tool_calls")).toThrow(AgentModelError)
    expect(() => accumulator.complete("length")).toThrow(AgentModelError)
  })

  it("uses callId as the identity when a compatible provider changes indexes", () => {
    const accumulator = new ToolCallAccumulator()
    accumulator.accept(0, { callId: "call_1", name: "jobs.search" }, '{"q":"')
    accumulator.accept(2, { callId: "call_1" }, 'Berlin"}')
    expect(accumulator.complete("tool_calls")).toContainEqual({
      type: "tool_call_completed", callId: "call_1", name: "jobs.search", arguments: { q: "Berlin" },
    })
  })
})
