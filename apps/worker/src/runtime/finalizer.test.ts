import { describe, expect, it } from "vitest"

import { finalizeTurn, serializeFinalResponse } from "./finalizer.js"

describe("deterministic finalizer", () => {
  it("always emits the required final shape and attributable usage", () => {
    const response = finalizeTurn({ goal: "Find a role", terminalReason: "budget_exhausted", blocker: "Budget exhausted", usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0.02 }, stepCount: 2, toolCallCount: 1, next: ["Resume", "Resume"] })
    expect(response).toMatchObject({ completed: false, notCompleted: ["Find a role"], blocker: "Budget exhausted", next: ["Resume"], usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0.02 } })
    expect(response).not.toHaveProperty("answerEvidence")
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

  it("omits invalid answer evidence without changing the final response or completion decision", () => {
    const response = finalizeTurn({ goal: "Find a role", verification: { ok: true, evidenceRefs: [], businessChecks: [] }, terminalReason: "goal_satisfied",
      response: "Role found.", answerEvidence: { schemaVersion: 1, sources: [{ key: "S1", kind: "job", label: "Engineer", excerpt: "Dublin role." }], rawOutput: "PRIVATE_OUTPUT" },
      usage: { inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 }, stepCount: 3, toolCallCount: 2 })

    expect(response.completed).toBe(true)
    expect(response.response).toBe("Role found.")
    expect(response).not.toHaveProperty("answerEvidence")
    expect(serializeFinalResponse(response)).not.toContain("PRIVATE_OUTPUT")
  })
})
