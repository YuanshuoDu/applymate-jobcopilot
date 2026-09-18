import { describe, expect, it } from "vitest"

import {
  buildReplanFeedback,
  MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS,
  replanFeedbackAttempts,
} from "./plan-replan-feedback.js"

const obligation = {
  id: "plan-replan:plan-1:1",
  sourceObservationId: "plan-control:plan-1:join:replan",
  planCallId: "plan-1",
  goalRevision: 1,
  planRevision: 1,
  joinLocalId: "join",
  failedTaskIds: ["child-1"],
} as const

describe("plan replan feedback", () => {
  it("is deterministic and rejects malformed or over-bound attempts", () => {
    const first = buildReplanFeedback("turn-1", obligation, 1)
    expect(first).toEqual(buildReplanFeedback("turn-1", obligation, 1))
    expect(replanFeedbackAttempts([first!], "turn-1", obligation)).toEqual({ valid: true, highest: 1 })
    expect(buildReplanFeedback("turn-1", obligation, MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS + 1)).toBeNull()
    expect(replanFeedbackAttempts([{ ...first!, content: { ...first!.content, attempt: 2 } }], "turn-1", obligation)).toEqual({ valid: false })
  })

  it("rejects obligations whose server-owned identity does not match the failed plan", () => {
    expect(buildReplanFeedback("turn-1", { ...obligation, id: "plan-replan:other:1" }, 1)).toBeNull()
    expect(buildReplanFeedback("turn-1", { ...obligation, sourceObservationId: "plan-control:other:join:replan" }, 1)).toBeNull()
    expect(replanFeedbackAttempts([], "turn-1", { ...obligation, id: "forged" })).toEqual({ valid: false })
  })
})
