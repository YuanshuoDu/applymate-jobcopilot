import { describe, expect, it } from "vitest"

import { resolveLatestAcceptedPlanCallId, replanSignalPlanCallId } from "./plan-revision-scope.js"

const projection = (planCallId: string, planRevision: number, basedOnPlanRevision: number | null, goalRevision = 1) => ({
  id: `plan-revision:${planCallId}`,
  content: { kind: "plan_revision", planCallId, goalRevision, planRevision, basedOnPlanRevision },
})
const signal = (planCallId: string) => ({
  id: `plan-control:${planCallId}:join:replan`,
  content: { kind: "plan_control", localId: "join:replan", status: "replan_required", dependsOn: ["child"], reason: "child_failure", failedTaskIds: ["child-1"] },
})

describe("plan revision scope", () => {
  it("resolves the latest contiguous accepted plan and canonical signal id", () => {
    expect(resolveLatestAcceptedPlanCallId([projection("plan-1", 1, null), projection("plan-2", 2, 1)], 1)).toEqual({ kind: "known", planCallId: "plan-2", planRevision: 2 })
    expect(replanSignalPlanCallId(signal("plan-1"))).toBe("plan-1")
  })

  it.each([
    ["duplicate", [projection("plan-1", 1, null), projection("other", 1, null)]],
    ["gap", [projection("plan-1", 1, null), projection("plan-3", 3, 2)]],
    ["legacy revision one", [{ id: "plan-revision:legacy", content: { kind: "plan_revision", goalRevision: 1, planRevision: 1 } }]],
  ])("fails closed for %s revision history", (_name, observations) => {
    expect(resolveLatestAcceptedPlanCallId(observations, 1)).toEqual({ kind: "unknown" })
  })

  it("fails closed for malformed replan signal identity", () => {
    expect(replanSignalPlanCallId({ id: "plan-control:plan-1:join:replan", content: { kind: "plan_control", status: "replan_required" } })).toBeNull()
  })
})
