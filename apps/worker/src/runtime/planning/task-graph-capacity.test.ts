import { describe, expect, it } from "vitest"

import { TASK_GRAPH_LIMITS } from "./task-graph.js"
import { taskGraphNodeCapacity } from "./task-graph-capacity.js"

describe("TaskGraph first-repair capacity", () => {
  it("keeps eight slots for graphs without typed verification", () => {
    expect(taskGraphNodeCapacity({ nodeCount: 7, hasTypedVerification: false, repairRecorded: false })).toEqual({
      nodeCount: 7, maxNodes: TASK_GRAPH_LIMITS.maxNodes, remaining: 1, ordinaryRemaining: 1,
      reserveActive: false, repairRecorded: false,
    })
    expect(taskGraphNodeCapacity({ nodeCount: 8, hasTypedVerification: false, repairRecorded: false })?.ordinaryRemaining).toBe(0)
  })

  it("reserves one position until a repair is recorded without exceeding eight", () => {
    expect(taskGraphNodeCapacity({ nodeCount: 0, hasTypedVerification: true, repairRecorded: false })?.ordinaryRemaining).toBe(7)
    expect(taskGraphNodeCapacity({ nodeCount: 7, hasTypedVerification: true, repairRecorded: false })).toEqual({
      nodeCount: 7, maxNodes: TASK_GRAPH_LIMITS.maxNodes, remaining: 1, ordinaryRemaining: 0,
      reserveActive: true, repairRecorded: false,
    })
    expect(taskGraphNodeCapacity({ nodeCount: 8, hasTypedVerification: true, repairRecorded: false })).toEqual({
      nodeCount: 8, maxNodes: TASK_GRAPH_LIMITS.maxNodes, remaining: 0, ordinaryRemaining: 0,
      reserveActive: false, repairRecorded: false,
    })
  })

  it("releases the one global reserve only when a repair relation is present", () => {
    expect(taskGraphNodeCapacity({ nodeCount: 6, hasTypedVerification: true, repairRecorded: true })).toEqual({
      nodeCount: 6, maxNodes: TASK_GRAPH_LIMITS.maxNodes, remaining: 2, ordinaryRemaining: 2,
      reserveActive: false, repairRecorded: true,
    })
  })

  it("fails closed for malformed facts", () => {
    for (const value of [undefined, null, [], { nodeCount: 9, hasTypedVerification: true, repairRecorded: false },
      { nodeCount: 1, hasTypedVerification: false, repairRecorded: true },
      { nodeCount: 1, hasTypedVerification: true, repairRecorded: false, extra: true }]) {
      expect(taskGraphNodeCapacity(value)).toBeUndefined()
    }
  })
})
