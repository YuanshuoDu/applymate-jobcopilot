import { describe, expect, it } from "vitest"

import { PLAN_PROPOSAL_SCHEMA_VERSION, type PlanProposal } from "./goal-plan-contract.js"
import { copyPlanFingerprints, fingerprintPlanProposal, isPlanFingerprint } from "./plan-fingerprint.js"

function proposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null,
    nodes: [{ localId: "read", kind: "use_tool", objective: "Read jobs", inputRefs: [], dependsOn: [], successCriteria: ["results"], outputSchemaRef: null, toolName: "jobs.search" }],
    completionCriteria: ["review"], briefRationale: "bounded", ...overrides,
  }
}

describe("plan fingerprint", () => {
  it("is stable across object key order and CAS metadata", () => {
    const first = proposal()
    const reordered = { briefRationale: first.briefRationale, completionCriteria: first.completionCriteria, nodes: first.nodes, basedOnPlanRevision: 4, basedOnGoalRevision: 1, schemaVersion: first.schemaVersion }
    expect(fingerprintPlanProposal(first)).toBe(fingerprintPlanProposal(reordered))
    expect(fingerprintPlanProposal(first)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("changes when semantic content or goal revision changes", () => {
    expect(fingerprintPlanProposal(proposal())).not.toBe(fingerprintPlanProposal(proposal({ briefRationale: "different" })))
    expect(fingerprintPlanProposal(proposal())).not.toBe(fingerprintPlanProposal(proposal({ basedOnGoalRevision: 2 })))
  })

  it("strictly validates and copies bounded hash collections", () => {
    const hash = fingerprintPlanProposal(proposal())
    expect(isPlanFingerprint(hash)).toBe(true)
    expect(isPlanFingerprint("sha256:ABC")).toBe(false)
    const copied = copyPlanFingerprints([hash])
    expect(copied).toEqual([hash])
    expect(() => copyPlanFingerprints(["bad"])).toThrow()
    expect(() => copyPlanFingerprints([hash, hash])).toThrow()
  })
})
