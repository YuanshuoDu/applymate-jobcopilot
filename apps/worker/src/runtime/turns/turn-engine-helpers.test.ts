import { describe, expect, it } from "vitest"

import { isTurnLeaseLoss, turnErrorCode } from "./turn-engine-helpers.js"

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
})
