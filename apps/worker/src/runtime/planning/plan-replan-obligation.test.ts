import { describe, expect, it } from "vitest"

import {
  deriveReplanObligation,
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

const waitingJoin = (callId = "plan-1", waitId = "wait-1") => ({
  id: `plan-result:${callId}:join`,
  content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["child"], status: "completed", errorCode: null, output: { waitId, status: "waiting", taskIds: ["child-1"], matchedTaskIds: [] } },
})

const waitResult = (waitId = "wait-1", status: "ready" | "timed_out" = "ready", taskStatus = "failed", toolName: "agent.wait" | "wait_subagents" = "wait_subagents") => ({
  id: `wait-result:${waitId}`,
  content: { toolCallId: `wait:${waitId}`, toolName, input: { taskIds: ["child-1"], mode: "all" }, status: "completed", output: { waitId, status, targetTaskIds: ["child-1"], matchedTaskIds: status === "ready" ? ["child-1"] : [], tasks: [{ taskId: "child-1", status: taskStatus, result: null, failureReason: taskStatus === "failed" ? "provider error" : null }] }, errorCode: null },
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
    { name: "duplicate signal", observations: [...activeObservations(), signal()] },
    { name: "unsorted IDs", observations: [projection("plan-1", 1, null), join(), signal("plan-1", ["child-2", "child-1"])] },
    { name: "conflicting accepted revision", observations: [...activeObservations(), projection("other-plan", 1, null)] },
    { name: "revision gap", observations: [...activeObservations(), projection("plan-3", 3, 2)] },
  ])("fails closed for $name", ({ observations }) => {
    expect(deriveReplanObligation({ observations, expectedGoalRevision: 1 }).kind).toBe("invalid")
  })

  it("accepts a legacy projection without an optional proposal hash", () => {
    const legacy = { ...projection("plan-1", 1, null) }
    delete (legacy.content as Record<string, unknown>).proposalHash
    expect(deriveReplanObligation({ observations: [legacy, join(), signal()], expectedGoalRevision: 1 }).kind).toBe("active")
  })

  it("ignores a valid obligation from a superseded goal revision", () => {
    expect(deriveReplanObligation({ observations: activeObservations(), expectedGoalRevision: 2 })).toEqual({ kind: "none" })
  })

  it("ignores old history while enforcing the current goal obligation", () => {
    const current = [projection("current-plan", 1, null, 2), join("current-plan"), signal("current-plan")]
    const result = deriveReplanObligation({ observations: [...activeObservations(), ...current], expectedGoalRevision: 2 })
    expect(result).toMatchObject({ kind: "active", obligation: { planCallId: "current-plan", goalRevision: 2 } })
  })

  it("fails closed for a future goal signal", () => {
    const future = [projection("future-plan", 1, null, 2), join("future-plan"), signal("future-plan")]
    expect(deriveReplanObligation({ observations: future, expectedGoalRevision: 1 })).toMatchObject({ kind: "invalid", reason: "future_replan_signal" })
  })

  it.each([
    {
      name: "malformed old signal",
      observations: [projection("old-plan", 1, null, 1), join("old-plan"), { ...signal("old-plan"), content: { ...signal("old-plan").content, failedTaskIds: ["child-2", "child-1"] } }],
    },
    {
      name: "malformed old plan",
      observations: [{ ...projection("old-plan", 1, null, 1), content: { ...projection("old-plan", 1, null, 1).content, basedOnPlanRevision: 1 } }, join("old-plan"), signal("old-plan")],
    },
  ])("fails closed for $name instead of ignoring malformed history", ({ observations }) => {
    expect(deriveReplanObligation({ observations, expectedGoalRevision: 2 }).kind).toBe("invalid")
  })

  it("rebuilds an active obligation from a durable failed wait when the control signal is missing", () => {
    const result = deriveReplanObligation({ observations: [projection("plan-1", 1, null), waitingJoin(), waitResult()], expectedGoalRevision: 1 })
    expect(result).toMatchObject({ kind: "active", obligation: { sourceObservationId: "plan-control:plan-1:join:replan", failedTaskIds: ["child-1"] } })
  })

  it("rebuilds an active obligation from a canonical agent.wait result", () => {
    const result = deriveReplanObligation({ observations: [projection("plan-1", 1, null), waitingJoin(), waitResult("wait-1", "ready", "failed", "agent.wait")], expectedGoalRevision: 1 })
    expect(result).toMatchObject({ kind: "active", obligation: { sourceObservationId: "plan-control:plan-1:join:replan", failedTaskIds: ["child-1"] } })
  })

  it.each([
    { name: "missing wait result", observations: [projection("plan-1", 1, null), waitingJoin(), signal()] },
    { name: "foreign tool identity", observations: [projection("plan-1", 1, null), waitingJoin(), { ...waitResult(), content: { ...waitResult().content, toolCallId: "wait:other" } }, signal()] },
    { name: "missing join wait id", observations: [projection("plan-1", 1, null), { ...join(), content: { ...join().content, output: { status: "ready", taskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "failed", result: null, failureReason: "provider error" }] } } }, signal()] },
    { name: "existing signal conflicts with durable result", observations: [projection("plan-1", 1, null), waitingJoin(), waitResult(), signal("plan-1", ["child-2"])] },
  ])("fails closed for $name during durable wait recovery", ({ observations }) => {
    expect(deriveReplanObligation({ observations, expectedGoalRevision: 1 }).kind).toBe("invalid")
  })

})
