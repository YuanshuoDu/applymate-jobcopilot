import { describe, expect, it } from "vitest"
import { reduceTaskGraphFinalSummary } from "./task-graph-final-summary.js"
import { normalizeResolvedRepairTaskIds, readResolvedRepairTaskIds } from "./task-graph-final-summary-repair-binding.js"

function summary(taskIds: readonly string[]) {
  return reduceTaskGraphFinalSummary({ graphRevision: 3, nodes: taskIds.map(taskId => ({
    kind: "business" as const, taskId, role: "analyst", taskStatus: "failed" as const,
  })) })
}

function members(taskIds: readonly string[]) {
  return taskIds.map((taskId, nodeIndex) => ({ kind: "business" as const, nodeIndex, nodeKey: "node-" + nodeIndex,
    templateId: "analyst", taskId, role: "analyst", taskType: "job_analysis", taskStatus: "failed" as const }))
}

describe("TaskGraph final-summary repair binding", () => {
  it("normalizes only failed business members represented by the summary", () => {
    const reduced = reduceTaskGraphFinalSummary({ graphRevision: 3, nodes: [
      { kind: "business", taskId: "failed-business", role: "analyst", taskStatus: "failed" },
      { kind: "business", taskId: "completed-business", role: "analyst", taskStatus: "completed" },
      { kind: "internal_control", taskId: "failed-control", role: "auditor", taskStatus: "failed" },
    ] })
    const boundMembers = [
      { kind: "business", taskId: "failed-business", taskStatus: "failed" },
      { kind: "business", taskId: "completed-business", taskStatus: "completed" },
      { kind: "internal_control", taskId: "failed-control", taskStatus: "failed" },
    ]

    expect(normalizeResolvedRepairTaskIds(new Set([
      "completed-business", "failed-control", "not-in-summary", "failed-business", "unsafe/id",
    ]), boundMembers, reduced)).toEqual(["failed-business"])
    expect(normalizeResolvedRepairTaskIds(undefined, boundMembers, reduced)).toBeUndefined()
  })

  it("reads only sorted, current failed task IDs from a valid private binding", () => {
    const taskIds = ["failed-a", "failed-b"]
    const base = { rootTaskId: "root-task", graphItemId: "task-graph:root-task", graphRevision: 3,
      members: members(taskIds), summary: summary(taskIds) }

    expect(readResolvedRepairTaskIds({ ...base, resolvedRepairTaskIds: taskIds })).toEqual(new Set(taskIds))
    expect(readResolvedRepairTaskIds({ ...base, resolvedRepairTaskIds: taskIds,
      executionFailureOutcomes: [{ taskId: "failed-a", category: "deadline" }] })).toEqual(new Set(taskIds))
    expect(readResolvedRepairTaskIds({ ...base, resolvedRepairTaskIds: taskIds,
      executionFailureOutcomes: [], unexpected: true })).toEqual(new Set())
    expect(readResolvedRepairTaskIds({ ...base, resolvedRepairTaskIds: [...taskIds].reverse() })).toEqual(new Set())
    expect(readResolvedRepairTaskIds({ ...base, resolvedRepairTaskIds: ["foreign-task"] })).toEqual(new Set())
    expect(readResolvedRepairTaskIds({ ...base, resolvedRepairTaskIds: ["failed-a", "failed-a"] })).toEqual(new Set())
  })
})
