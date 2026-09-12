import { describe, expect, it } from "vitest"

import {
  buildPlanCompletionFeedback,
  buildPlanCompletionFeedbackEvent,
  currentPlanId,
  MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS,
  parsePlanCompletionFeedback,
  parsePlanCompletionFeedbackEvent,
  PLAN_COMPLETION_FEEDBACK_EVENT_TYPE,
  planCompletionFeedbackIdempotencyKey,
  planCompletionRecoveryCount,
  restorePlanCompletionFeedback,
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

  it("builds a fixed canonical event with a stable identity key", () => {
    const stepId = "turn:turn-1:step:0"
    const event = buildPlanCompletionFeedbackEvent({ turnId, stepId, attempt: 1, planId: "plan-1" })
    expect(event).toEqual({
      observationId: "plan-completion-feedback:turn:turn-1:step:0",
      turnId,
      stepId,
      attempt: 1,
      status: "blocked",
      blocker: "plan_completion_unverified",
      feedback: "Re-propose or correct the server-owned plan and complete its completion control before answering.",
      planId: "plan-1",
    })
    expect(planCompletionFeedbackIdempotencyKey(stepId)).toBe("plan-completion-feedback:turn:turn-1:step:0")
    expect(parsePlanCompletionFeedbackEvent(event, turnId, "plan-1")).toEqual(event)
    expect(JSON.stringify(event)).not.toContain("model supplied")
  })

  it("fails closed for forged event identity and payload fields", () => {
    const event = buildPlanCompletionFeedbackEvent({ turnId, stepId: "turn:turn-1:step:0", attempt: 1, planId: "plan-1" })!
    expect(parsePlanCompletionFeedbackEvent({ ...event, turnId: "turn-2" }, turnId, "plan-1")).toBeNull()
    expect(parsePlanCompletionFeedbackEvent({ ...event, stepId: "turn:turn-2:step:0" }, turnId, "plan-1")).toBeNull()
    expect(parsePlanCompletionFeedbackEvent({ ...event, planId: "plan-2" }, turnId, "plan-1")).toBeNull()
    expect(parsePlanCompletionFeedbackEvent({ ...event, attempt: MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS + 1 }, turnId, "plan-1")).toBeNull()
    expect(parsePlanCompletionFeedbackEvent({ ...event, untrusted: "model text" }, turnId, "plan-1")).toBeNull()
  })

  it("restores one current-plan projection and ignores duplicates, foreign plans, and malformed payloads", () => {
    const stepId = "turn:turn-1:step:0"
    const valid = buildPlanCompletionFeedbackEvent({ turnId, stepId, attempt: 1, planId: "plan-1" })!
    const restored = restorePlanCompletionFeedback([
      { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: valid },
      { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: valid },
      { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: { ...valid, planId: "plan-2" } },
      { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: { ...valid, turnId: "turn-2" } },
      { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: { ...valid, feedback: "model text" } },
      { type: PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, payload: { ...valid, attempt: MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS + 1 } },
    ], turnId, "plan-1")
    expect(restored).toEqual([{ id: valid.observationId, content: expect.objectContaining({ attempt: 1, kind: "plan_completion_feedback" }) }])
    expect(planCompletionRecoveryCount(restored, turnId)).toBe(1)
  })

  it("resolves the latest server-owned plan identity after a goal revision", () => {
    const observations = [
      { id: "plan-revision:old", content: { kind: "plan_revision", planCallId: "old", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
      { id: "goal-revision:2", content: { kind: "goal_revision", goalRevision: 2 } },
      { id: "plan-revision:new", content: { kind: "plan_revision", planCallId: "new", goalRevision: 2, planRevision: 1, basedOnPlanRevision: null } },
    ]
    expect(currentPlanId(observations)).toBe("new")
    expect(currentPlanId(observations.slice(0, 2))).toBeNull()
  })
})
