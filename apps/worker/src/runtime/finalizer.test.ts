import { describe, expect, it } from "vitest"

import { finalizeTurn, serializeFinalResponse } from "./finalizer.js"

describe("deterministic finalizer", () => {
  it("always emits the required final shape and attributable usage", () => {
    const response = finalizeTurn({ goal: "Find a role", terminalReason: "budget_exhausted", blocker: "Budget exhausted", usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0.02 }, stepCount: 2, toolCallCount: 1, next: ["Resume", "Resume"] })
    expect(response).toMatchObject({ completed: false, notCompleted: ["Find a role"], blocker: "Budget exhausted", next: ["Resume"], usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0.02 } })
    expect(JSON.parse(serializeFinalResponse(response))).toEqual(response)
  })
})
