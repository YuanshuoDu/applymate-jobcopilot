import { describe, expect, it } from "vitest"

import { evaluateCompactionTrigger } from "./context-compaction-trigger.js"

const policy = { inputTokenThreshold: 100, itemCountThreshold: 10, compactAtTurnBoundary: true }

describe("compaction trigger policy", () => {
  it("prioritizes manual requests and otherwise uses deterministic thresholds", () => {
    expect(evaluateCompactionTrigger({ inputTokens: 0, itemCount: 0, atTurnBoundary: false, requested: true }, policy)).toEqual({ shouldCompact: true, reason: "manual" })
    expect(evaluateCompactionTrigger({ inputTokens: 100, itemCount: 1, atTurnBoundary: false, requested: false }, policy).reason).toBe("input_tokens")
    expect(evaluateCompactionTrigger({ inputTokens: 0, itemCount: 10, atTurnBoundary: false, requested: false }, policy).reason).toBe("item_count")
    expect(evaluateCompactionTrigger({ inputTokens: 0, itemCount: 1, atTurnBoundary: true, requested: false }, policy).reason).toBe("turn_boundary")
  })

  it("does not trigger for an empty or below-threshold session", () => {
    expect(evaluateCompactionTrigger({ inputTokens: 99, itemCount: 9, atTurnBoundary: false, requested: false }, policy)).toEqual({ shouldCompact: false, reason: null })
    expect(evaluateCompactionTrigger({ inputTokens: 100, itemCount: 0, atTurnBoundary: false, requested: false }, policy)).toEqual({ shouldCompact: false, reason: null })
  })

  it("rejects invalid policy values", () => {
    expect(() => evaluateCompactionTrigger({ inputTokens: 0, itemCount: 0, atTurnBoundary: false, requested: false }, { ...policy, itemCountThreshold: 0 })).toThrow("positive")
  })
})
