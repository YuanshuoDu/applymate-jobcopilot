import { describe, expect, it } from "vitest"

import {
  buildReplanFeedback,
  deriveReplanObligation,
  replanFeedbackAttempts,
} from "./plan-replan-obligation.js"

const projection = (planCallId: string, planRevision: number, basedOnPlanRevision: number | null, goalRevision = 1) => ({
  id: `plan-revision:${planCallId}`,
  content: { kind: "plan_revision", planCallId, goalRevision, planRevision, basedOnPlanRevision, proposalHash: "sha256:" + "0".repeat(64) },
})

const join = (callId = "plan-1", failedTaskIds = ["child-1"]) => ({
  id: `plan-result:${callId}:join`,
  content: {
    kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["child"], status: "completed", errorCode: null,
    output: { waitId: "wait-1", status: "ready", taskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "failed", result: null, failureReason: "provider error" }],
      ...(failedTaskIds.length === 0 ? { tasks: [{ taskId: "child-1", status: "completed", result: null, failureReason: null }] } : {}) },
  },
})

const signal = (callId = "plan-1", failedTaskIds = ["child-1"]) => ({
  id: `plan-control:${callId}:join:replan`,
  content: { kind: "plan_control", localId: "join:replan", status: "replan_required", dependsOn: ["child"], reason: "child_failure", failedTaskIds },
})

function activeObservations() { return [projection("plan-1", 1, null), join(), signal()] }

describe("plan replan obligation", () => {
  it("derives an active obligation from the server projection and join evidence", () => {
    const result = deriveReplanObligation({ observations: activeObservations(), expectedGoalRevision: 1 })
    expect(result).toMatchObject({ kind: "active", obligation: { id: "plan-replan:plan-1:1", planCallId: "plan-1", planRevision: 1, joinLocalId: "join", failedTaskIds: ["child-1"] } })
  })

  it("resolves only when the next accepted revision is explicitly based on the failure", () => {
    const result = deriveReplanObligation({ observations: [...activeObservations(), projection("plan-2", 2, 1)], expectedGoalRevision: 1 })
    expect(result).toEqual({ kind: "none" })
    expect(deriveReplanObligation({ observations: [...activeObservations(), projection("plan-2", 2, null)], expectedGoalRevision: 1 }).kind).toBe("invalid")
  })

  it.each([
    { name: "missing projection", observations: [join(), signal()] },
    { name: "missing join", observations: [projection("plan-1", 1, null), signal()] },
    { name: "foreign goal", observations: [...activeObservations()], expectedGoalRevision: 2 },
    { name: "duplicate signal", observations: [...activeObservations(), signal()] },
    { name: "unsorted IDs", observations: [projection("plan-1", 1, null), join(), signal("plan-1", ["child-2", "child-1"])] },
    { name: "conflicting accepted revision", observations: [...activeObservations(), projection("other-plan", 1, null)] },
    { name: "revision gap", observations: [...activeObservations(), projection("plan-3", 3, 2)] },
  ])("fails closed for $name", ({ observations, expectedGoalRevision = 1 }) => {
    expect(deriveReplanObligation({ observations, expectedGoalRevision }).kind).toBe("invalid")
  })

  it("accepts a legacy projection without an optional proposal hash", () => {
    const legacy = { ...projection("plan-1", 1, null) }
    delete (legacy.content as Record<string, unknown>).proposalHash
    expect(deriveReplanObligation({ observations: [legacy, join(), signal()], expectedGoalRevision: 1 }).kind).toBe("active")
  })

  it("keeps feedback deterministic, bounded, and idempotent", () => {
    const result = deriveReplanObligation({ observations: activeObservations(), expectedGoalRevision: 1 })
    if (result.kind !== "active") throw new Error("expected active obligation")
    const first = buildReplanFeedback("turn-1", result.obligation, 1)!
    const second = buildReplanFeedback("turn-1", result.obligation, 2)!
    expect(replanFeedbackAttempts([first], "turn-1", result.obligation)).toEqual({ valid: true, highest: 1 })
    expect(replanFeedbackAttempts([first, second], "turn-1", result.obligation)).toEqual({ valid: true, highest: 2 })
    expect(replanFeedbackAttempts([{ ...first, content: { ...first.content, failedTaskIds: ["forged"] } }], "turn-1", result.obligation)).toEqual({ valid: false })
    expect(buildReplanFeedback("turn-1", result.obligation, 3)).toBeNull()
  })
})
