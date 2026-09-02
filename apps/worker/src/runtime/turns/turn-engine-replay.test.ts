import { describe, expect, it } from "vitest"

import { findToolObservation, stableJson } from "./turn-engine-replay.js"

describe("TurnEngine replay helpers", () => {
  it("canonicalizes object key order for replay comparison", () => {
    expect(stableJson({ b: 2, a: { d: true, c: 1 } })).toBe('{"a":{"c":1,"d":true},"b":2}')
  })

  it("finds the persisted tool input by call id", () => {
    const result = findToolObservation({
      system: [], profile: [], steerHistory: [], businessRefs: [],
      toolObservations: [{ id: "tool-result:call-1", content: { toolCallId: "call-1", toolName: "jobs.search", input: { query: "Dublin" } } }],
    }, "call-1")
    expect(result).toEqual({ toolName: "jobs.search", input: { query: "Dublin" } })
  })
})
