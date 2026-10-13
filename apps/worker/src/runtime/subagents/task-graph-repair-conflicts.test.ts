import { describe, expect, it } from "vitest"
import type { TaskGraphNode, TaskGraphNodeProposal, TaskGraphRepairOf } from "../planning/task-graph.js"
import { hasOverlappingTaskGraphRepair } from "./task-graph-repair-conflicts.js"

const relation = (criterionIds: string[], changes: Partial<TaskGraphRepairOf> = {}): TaskGraphRepairOf => ({
  graphRootTaskId: "root-1", nodeKey: "target", taskId: "target-1", criterionIds, ...changes,
})

function currentRepair(status: TaskGraphNode["status"], repairOf = relation(["finding-count"])): TaskGraphNode {
  return {
    key: "repair-current", templateId: "analyst", goal: "Repair target", successCriteria: ["repair"],
    dependsOn: [], depth: 1, status, taskId: "repair-task", repairOf,
  }
}

function proposal(repairOf = relation(["finding-count"]), key = "repair-next"): TaskGraphNodeProposal {
  return {
    key, templateId: "analyst", goal: "Repair target again", successCriteria: ["repair"],
    dependsOn: [], repairOf,
  }
}

describe("hasOverlappingTaskGraphRepair", () => {
  it.each(["queued", "running", "retrying", "waiting", "waiting_for_user"] as const)(
    "blocks an overlapping repair while the current repair is %s",
    status => expect(hasOverlappingTaskGraphRepair([currentRepair(status)], [proposal()])).toBe(true),
  )

  it.each(["completed", "failed", "interrupted", "cancelled", "closed"] as const)(
    "does not treat terminal repair status as in-flight (%s)",
    status => expect(hasOverlappingTaskGraphRepair([currentRepair(status)], [proposal()])).toBe(false),
  )

  it("requires an exact root, target key, task id, and intersecting criterion", () => {
    const active = currentRepair("running")
    expect(hasOverlappingTaskGraphRepair([active], [proposal(relation(["evidence-count"]))])).toBe(false)
    expect(hasOverlappingTaskGraphRepair([active], [proposal(relation(["finding-count"], { graphRootTaskId: "root-2" }))])).toBe(false)
    expect(hasOverlappingTaskGraphRepair([active], [proposal(relation(["finding-count"], { nodeKey: "other-target" }))])).toBe(false)
    expect(hasOverlappingTaskGraphRepair([active], [proposal(relation(["finding-count"], { taskId: "other-task" }))])).toBe(false)
  })

  it("blocks overlapping repairs in the same proposal but allows disjoint work", () => {
    const first = proposal(relation(["finding-count", "evidence-count"]))
    expect(hasOverlappingTaskGraphRepair([], [first, proposal(relation(["evidence-count"]), "repair-next-2")])).toBe(true)
    expect(hasOverlappingTaskGraphRepair([], [first, proposal(relation(["other-count"]), "repair-next-2")])).toBe(false)
    expect(hasOverlappingTaskGraphRepair([], [first, { key: "ordinary", templateId: "analyst", goal: "Continue", successCriteria: ["done"], dependsOn: [] }])).toBe(false)
  })
})
