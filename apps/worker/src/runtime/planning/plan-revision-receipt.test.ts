import { describe, expect, it } from "vitest"

import { parsePlanRevisionEvent, parsePlanRevisionReceipt, planRevisionObservation } from "./plan-revision-receipt.js"

const proposal = { schemaVersion: "agent-harness.plan.v1", basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "bounded" }
const accepted = { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [] }

describe("plan revision receipt", () => {
  it("parses accepted output with a server supplied call id", () => {
    const receipt = parsePlanRevisionReceipt(accepted, "call-1")
    expect(receipt).toEqual({ planCallId: "call-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null })
  })

  it("rejects malformed, non-finite, unknown, and broken CAS metadata", () => {
    expect(parsePlanRevisionReceipt({ ...accepted, planRevision: 2 }, "call-1")).toBeNull()
    expect(parsePlanRevisionReceipt({ ...accepted, extra: "identity" }, "call-1")).toBeNull()
    expect(parsePlanRevisionReceipt({ ...accepted, goalRevision: Number.NaN }, "call-1")).toBeNull()
    expect(parsePlanRevisionEvent({ planCallId: "call-1", goalRevision: 1, planRevision: 2, basedOnPlanRevision: null })).toBeNull()
  })

  it("parses event metadata and emits a compact observation", () => {
    const receipt = parsePlanRevisionEvent({ planCallId: "call-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 })!
    expect(planRevisionObservation(receipt)).toEqual({ id: "plan-revision:call-2", content: { kind: "plan_revision", ...receipt } })
  })
})
