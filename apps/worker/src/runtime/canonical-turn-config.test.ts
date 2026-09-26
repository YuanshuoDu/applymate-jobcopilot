import { describe, expect, it } from "vitest"

import { capabilities, limits } from "./canonical-turn-config.js"

describe("canonical turn configuration", () => {
  it("defaults tool capabilities to read and filters non-string entries", () => {
    expect(capabilities({})).toEqual(["read"])
    expect(capabilities({ capabilities: ["read", 3, "apply"] })).toEqual(["read", "apply"])
    expect(capabilities({ capabilities: "apply" })).toEqual(["read"])
  })

  it("accepts only finite non-negative budget limits from wrapped or direct snapshots", () => {
    expect(limits({ limits: { maxSteps: 4, maxInputTokens: 100, maxOutputTokens: -1, maxCostUsd: Infinity, extra: 8 } }))
      .toEqual({ maxSteps: 4, maxInputTokens: 100 })
    expect(limits({ maxToolCalls: 0 })).toEqual({ maxToolCalls: 0 })
    expect(limits({ limits: { maxSteps: "4" } })).toBeUndefined()
  })
})
