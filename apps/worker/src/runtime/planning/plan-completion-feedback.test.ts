import { describe, expect, it } from "vitest"

import {
  buildPlanCompletionFeedback,
  MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS,
  parsePlanCompletionFeedback,
  planCompletionRecoveryCount,
} from "./plan-completion-feedback.js"

const turnId = "turn-1"

describe("plan completion feedback", () => {
  it("builds and parses the fixed server-owned observation", () => {
    const observation = buildPlanCompletionFeedback("turn:turn-1:step:0", 1)
    expect(observation).toEqual({
      id: "plan-completion-feedback:turn:turn-1:step:0",
      content: {
        kind: "plan_completion_feedback",
        status: "blocked",
        attempt: 1,
        blocker: "plan_completion_unverified",
        feedback: "Re-propose or correct the server-owned plan and complete its completion control before answering.",
      },
    })
    expect(parsePlanCompletionFeedback(observation, turnId)).toEqual(observation)
  })

  it("counts the highest valid attempt only for the current turn", () => {
    const first = buildPlanCompletionFeedback("turn:turn-1:step:0", 1)!
    const second = buildPlanCompletionFeedback("turn:turn-1:step:1", 2)!
    const foreign = buildPlanCompletionFeedback("turn:turn-2:step:0", 2)!
    const malformed = { id: first.id, content: { ...first.content, feedback: "model supplied text" } }
    expect(planCompletionRecoveryCount([first, second, foreign, malformed], turnId)).toBe(2)
  })

  it("rejects forged, malformed, and out of bound observations", () => {
    const valid = buildPlanCompletionFeedback("turn:turn-1:step:0", 1)!
    expect(parsePlanCompletionFeedback(valid, "turn-2")).toBeNull()
    expect(parsePlanCompletionFeedback({ ...valid, id: "plan-completion-feedback:turn:turn-2:step:0" }, turnId)).toBeNull()
    expect(parsePlanCompletionFeedback({ ...valid, content: { ...valid.content, attempt: MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS + 1 } }, turnId)).toBeNull()
    expect(buildPlanCompletionFeedback("turn:turn-1:step:0", 0)).toBeNull()
    expect(buildPlanCompletionFeedback("turn:turn-1:step:0", MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS + 1)).toBeNull()
  })
})
