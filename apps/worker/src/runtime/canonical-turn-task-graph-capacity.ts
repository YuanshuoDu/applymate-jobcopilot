import { taskGraphNodeCapacity, type TaskGraphNodeCapacity } from "./planning/task-graph-capacity.js"
import type { TaskGraphCurrentNode } from "./subagents/task-graph-command-port.js"
import { projectTaskGraphPlanningCounts, withTaskGraphPlanningCounts } from "./task-graph-planning-facts-context.js"

/** Adds only the bounded current-capacity and revision-matched count facts to the base observation. */
export function withTaskGraphCurrentPlanningObservation<T extends Record<string, unknown>>(
  base: T,
  planningFacts: unknown,
  revision: number,
  nodes: readonly TaskGraphCurrentNode[],
  maxChars: number,
): T | (T & { taskReportedCounts: NonNullable<ReturnType<typeof projectTaskGraphPlanningCounts>> })
  | (T & { nodeCapacity: TaskGraphNodeCapacity })
  | (T & { taskReportedCounts: NonNullable<ReturnType<typeof projectTaskGraphPlanningCounts>>; nodeCapacity: TaskGraphNodeCapacity }) {
  const counts = projectTaskGraphPlanningCounts(planningFacts, revision)
  const withCounts = withTaskGraphPlanningCounts(base, counts, maxChars)
  const capacity = projectCurrentCapacity(nodes)
  if (!capacity) return withCounts
  try {
    const candidate = { ...withCounts, nodeCapacity: capacity }
    const serialized = JSON.stringify(candidate)
    return serialized && serialized.length <= maxChars ? candidate : withCounts
  } catch {
    return withCounts
  }
}

function projectCurrentCapacity(nodes: readonly TaskGraphCurrentNode[]): TaskGraphNodeCapacity | undefined {
  return taskGraphNodeCapacity({
    nodeCount: nodes.length,
    hasTypedVerification: nodes.some(node => node.verificationCriterionIds !== undefined),
    repairRecorded: nodes.some(node => node.repairOf !== undefined),
  })
}
