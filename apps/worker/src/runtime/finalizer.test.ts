import { describe, expect, it } from "vitest"

import { finalizeTurn, serializeFinalResponse } from "./finalizer.js"

describe("deterministic finalizer", () => {
  it("always emits the required final shape and attributable usage", () => {
    const response = finalizeTurn({ goal: "Find a role", terminalReason: "budget_exhausted", blocker: "Budget exhausted", usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0.02 }, stepCount: 2, toolCallCount: 1, next: ["Resume", "Resume"] })
    expect(response).toMatchObject({ completed: false, notCompleted: ["Find a role"], blocker: "Budget exhausted", next: ["Resume"], usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0.02 } })
    expect(JSON.parse(serializeFinalResponse(response))).toEqual(response)
  })

  it("replaces only the advisory summary while preserving the candidate response", () => {
    const response = finalizeTurn({ goal: "Find a role", verification: { ok: true, evidenceRefs: [], businessChecks: [] }, terminalReason: "goal_satisfied", response: "verified model candidate",
      summaryOverride: "Task-reported results: discovered jobs: 1 (complete).",
      usage: { inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 }, stepCount: 3, toolCallCount: 2 })
    expect(response.response).toBe("verified model candidate")
    expect(response.summary).toBe("Task-reported results: discovered jobs: 1 (complete).")
    expect(response).toMatchObject({ completedTasks: ["Turn goal"], notCompleted: [], stepCount: 3, toolCallCount: 2 })
  })
})
