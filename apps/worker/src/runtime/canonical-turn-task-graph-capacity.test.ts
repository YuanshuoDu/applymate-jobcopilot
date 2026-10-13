import { describe, expect, it } from "vitest"
import type { TaskGraphCurrentNode } from "./subagents/task-graph-command-port.js"
import { withTaskGraphCurrentPlanningObservation } from "./canonical-turn-task-graph-capacity.js"

function currentNode(overrides: Partial<TaskGraphCurrentNode> = {}): TaskGraphCurrentNode {
  return {
    key: "current", templateId: "scout", goal: "Find evidence", successCriteria: ["Return evidence"], dependsOn: [],
    taskId: "private-task-id", status: "failed", readiness: "terminal", resultSummary: null, failureReason: null,
    ...overrides,
  }
}

function capacity(nodes: readonly TaskGraphCurrentNode[]) {
  const value = withTaskGraphCurrentPlanningObservation({ kind: "task_graph_current", revision: 4, nodes }, undefined, 4, nodes, 160_000)
  return "nodeCapacity" in value ? value.nodeCapacity : undefined
}

describe("current TaskGraph capacity projection", () => {
  it("reserves only the last lifetime slot while typed criteria have no accepted repair", () => {
    const value = capacity([currentNode({ verificationCriterionIds: ["finding-count"] })])

    expect(value).toEqual({ nodeCount: 1, maxNodes: 8, remaining: 7, ordinaryRemaining: 6, reserveActive: true, repairRecorded: false })
    expect(Object.keys(value ?? {}).sort()).toEqual([
      "maxNodes", "nodeCount", "ordinaryRemaining", "remaining", "repairRecorded", "reserveActive",
    ])
    expect(JSON.stringify(value)).not.toContain("private-task-id")
  })

  it("releases the global reserve for a current accepted repair relation", () => {
    const value = capacity([
      currentNode({ key: "target", verificationCriterionIds: ["finding-count"] }),
      currentNode({
        key: "repair", taskId: "repair-private-id", verificationCriterionIds: ["finding-count"],
        repairOf: { graphRootTaskId: "root-private-id", nodeKey: "target", taskId: "target-private-id", criterionIds: ["finding-count"] },
      }),
    ])

    expect(value).toMatchObject({ nodeCount: 2, maxNodes: 8, remaining: 6, ordinaryRemaining: 6, reserveActive: false, repairRecorded: true })
    expect(JSON.stringify(value)).not.toMatch(/private|root-private|target-private/)
  })

  it("keeps eight-node legacy and already-full typed histories readable with no append capacity", () => {
    const legacy = capacity(Array.from({ length: 8 }, (_, index) => currentNode({ key: `legacy-${index}` })))
    const oldTyped = capacity(Array.from({ length: 8 }, (_, index) => currentNode({ key: `typed-${index}`, verificationCriterionIds: ["finding-count"] })))

    expect(legacy).toMatchObject({ nodeCount: 8, remaining: 0, ordinaryRemaining: 0, reserveActive: false, repairRecorded: false })
    expect(oldTyped).toMatchObject({ nodeCount: 8, remaining: 0, ordinaryRemaining: 0, reserveActive: false, repairRecorded: false })
  })

  it("omits unsupported capacity without changing the base observation", () => {
    const nodes = Array.from({ length: 9 }, (_, index) => currentNode({ key: `unsupported-${index}` }))
    const base = { kind: "task_graph_current", revision: 4, nodes }

    expect(withTaskGraphCurrentPlanningObservation(base, undefined, 4, nodes, 160_000)).toEqual(base)
  })
})
