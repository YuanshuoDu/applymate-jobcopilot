import { describe, expect, it } from "vitest"
import { taskGraphCreateCapacityAllowed } from "./task-graph-pg-create-capacity.js"

describe("taskGraphCreateCapacityAllowed", () => {
  it("preserves the ordinary typed-verification reserved slot", () => {
    expect(taskGraphCreateCapacityAllowed({ nodeCount: 7, proposalCount: 1, hasTypedVerification: true, repairRecorded: false })).toBe(false)
    expect(taskGraphCreateCapacityAllowed({ nodeCount: 6, proposalCount: 1, hasTypedVerification: true, repairRecorded: false })).toBe(true)
  })

  it("reuses exactly the validated removed slots at the existing full graph size", () => {
    for (const removedNodeCount of [1, 3]) {
      expect(taskGraphCreateCapacityAllowed({ nodeCount: 8 - removedNodeCount, proposalCount: removedNodeCount,
        hasTypedVerification: true, repairRecorded: false, operationalFailureReuse: { originalNodeCount: 8, removedNodeCount } })).toBe(true)
    }
  })

  it("rejects mismatched reuse counts and any final size change", () => {
    const base = { hasTypedVerification: true, repairRecorded: false, operationalFailureReuse: { originalNodeCount: 8, removedNodeCount: 2 } }
    expect(taskGraphCreateCapacityAllowed({ ...base, nodeCount: 6, proposalCount: 1 })).toBe(false)
    expect(taskGraphCreateCapacityAllowed({ ...base, nodeCount: 6, proposalCount: 3 })).toBe(false)
    expect(taskGraphCreateCapacityAllowed({ ...base, nodeCount: 5, proposalCount: 2 })).toBe(false)
    expect(taskGraphCreateCapacityAllowed({ ...base, nodeCount: 7, proposalCount: 1 })).toBe(false)
  })
})
