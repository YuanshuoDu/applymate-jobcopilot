import { describe, expect, it } from "vitest"

import { normalizeUsageOwner } from "./usage-owner-fence"

describe("usage owner fence", () => {
  it("normalizes the existing root lease shape", () => {
    expect(normalizeUsageOwner({ leaseOwnerId: "worker-1", leaseVersion: 4 })).toEqual({ kind: "turn", leaseOwnerId: "worker-1", leaseVersion: 4 })
  })

  it("preserves the child task identity and captured attempt", () => {
    expect(normalizeUsageOwner({ executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-2", attemptCount: 3 } })).toEqual({ kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-2", attemptCount: 3 })
  })

  it("rejects mixed root and child identity", () => {
    expect(() => normalizeUsageOwner({ leaseOwnerId: "worker-1", leaseVersion: 4, executionOwner: { kind: "task", taskId: "child-1", rootTaskId: "root-1", ownerId: "worker-2", attemptCount: 3 } } as never)).toThrow("usage_owner_conflict")
  })
})
