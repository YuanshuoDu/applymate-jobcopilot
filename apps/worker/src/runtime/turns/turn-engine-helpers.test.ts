import { describe, expect, it } from "vitest"

import { isTurnLeaseLoss, resumedBudgetLimits, turnErrorCode } from "./turn-engine-helpers.js"

describe("TurnEngine helpers", () => {
  it("normalizes typed and unknown errors", () => {
    expect(turnErrorCode({ code: "budget_exhausted" })).toBe("budget_exhausted")
    expect(turnErrorCode(new Error("unknown"))).toBe("turn_execution_failed")
  })

  it("recognizes lease loss through the typed error or abort signal", () => {
    const controller = new AbortController()
    expect(isTurnLeaseLoss(new Error("no"), controller.signal)).toBe(false)
    controller.abort()
    expect(isTurnLeaseLoss(new Error("no"), controller.signal)).toBe(true)
  })

  it("subtracts durable plan action units from the resumed tool budget", () => {
    const resume = { nextOrdinal: 1, stepCount: 1, toolCallCount: 2, planActionCount: 2, inputThroughSequence: 1n, consumedInputIds: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }
    expect(resumedBudgetLimits({ maxToolCalls: 5 }, resume)).toEqual({ maxToolCalls: 1 })
    expect(resumedBudgetLimits({ maxToolCalls: 4 }, resume)).toEqual({ maxToolCalls: 0 })
    expect(resumedBudgetLimits({ maxToolCalls: 5 }, { ...resume, planActionCount: undefined })).toEqual({ maxToolCalls: 3 })
  })
})
