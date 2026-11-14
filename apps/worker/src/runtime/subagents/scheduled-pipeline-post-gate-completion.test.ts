import { describe, expect, it } from "vitest"
import { mapScheduledGateContinuationResult, mapScheduledPostGateResumeResult } from "./scheduled-pipeline-post-gate-completion.js"
import { SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK } from "./scheduled-post-gate-contract.js"

describe("scheduled post-Gate completion mapping", () => {
  it("keeps plan admission as a nonterminal Root replan", () => {
    const expected = { status: "replan", candidateText: "candidate", feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK }
    expect(mapScheduledGateContinuationResult({ status: "replan", feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK }, "candidate"))
      .toEqual(expected)
    expect(mapScheduledPostGateResumeResult({ status: "replan", feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK }, "candidate"))
      .toEqual(expected)
  })

  it("preserves post-Gate dependency and completion outcomes", () => {
    expect(mapScheduledPostGateResumeResult({ status: "waiting_for_dependency", waitId: "wait-1" }, "candidate"))
      .toEqual({ status: "waiting_for_dependency", waitId: "wait-1", candidateText: "candidate" })
    expect(mapScheduledPostGateResumeResult({ status: "completed" }, "candidate"))
      .toEqual({ status: "completed", candidateText: "candidate" })
  })

  it("fails closed for unexpected replay results and skips an absent legacy handler", () => {
    expect(mapScheduledPostGateResumeResult({ status: "gate_continuation", handoff: {} as never, prepareProof: {} as never }, "candidate"))
      .toEqual({ status: "blocked", errorCode: "scheduled_post_gate_resume_result_invalid" })
    expect(mapScheduledPostGateResumeResult({ status: "not_registered" }, "candidate")).toBeNull()
  })
})
