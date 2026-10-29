import { taskGraphNodeCapacity, type TaskGraphNodeCapacity } from "./planning/task-graph-capacity.js"
import type { TaskGraphCurrentNode } from "./subagents/task-graph-command-port.js"
import {
  projectTaskGraphPlanningCounts,
  projectTaskGraphPlanningScoutOverlap,
  withTaskGraphPlanningCounts,
  withTaskGraphPlanningScoutOverlap,
} from "./task-graph-planning-facts-context.js"

type Counts = NonNullable<ReturnType<typeof projectTaskGraphPlanningCounts>>
type ScoutOverlap = NonNullable<ReturnType<typeof projectTaskGraphPlanningScoutOverlap>>
type PlanningObservation<T extends Record<string, unknown>> = T & Partial<{
  taskReportedCounts: Counts
  taskReportedScoutOverlap: ScoutOverlap
  nodeCapacity: TaskGraphNodeCapacity
}>

/** Adds bounded capacity and current revision-bound advisory planning facts to the observation. */
export function withTaskGraphCurrentPlanningObservation<T extends Record<string, unknown>>(
  base: T,
  planningFacts: unknown,
  revision: number,
  nodes: readonly TaskGraphCurrentNode[],
  maxChars: number,
): PlanningObservation<T> {
  const counts = projectTaskGraphPlanningCounts(planningFacts, revision)
  const withCounts = withTaskGraphPlanningCounts(base, counts, maxChars)
  const capacity = projectCurrentCapacity(nodes)
  let withCapacity: Record<string, unknown> = withCounts
  if (capacity) {
    try {
      const candidate = { ...withCounts, nodeCapacity: capacity }
      const serialized = JSON.stringify(candidate)
      if (serialized && serialized.length <= maxChars) withCapacity = candidate
    } catch { /* Capacity is optional; keep the already-projected observation. */ }
  }
  const overlap = projectTaskGraphPlanningScoutOverlap(planningFacts, revision, nodes)
  return withTaskGraphPlanningScoutOverlap(withCapacity, overlap, maxChars) as PlanningObservation<T>
}

function projectCurrentCapacity(nodes: readonly TaskGraphCurrentNode[]): TaskGraphNodeCapacity | undefined {
  return taskGraphNodeCapacity({
    nodeCount: nodes.length,
    hasTypedVerification: nodes.some(node => node.verificationCriterionIds !== undefined),
    repairRecorded: nodes.some(node => node.repairOf !== undefined),
  })
}
