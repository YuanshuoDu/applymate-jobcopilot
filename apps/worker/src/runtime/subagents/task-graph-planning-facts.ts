import { buildTaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"

export type TaskGraphPlanningFacts = Readonly<{
  graphRevision: number
  counts: TaskGraphFinalSummary["counts"]
}>

/** Projects only aggregate counts from the already loaded current graph. */
export function buildTaskGraphPlanningFacts(loaded: LoadedGraph): TaskGraphPlanningFacts | null {
  try {
    const binding = buildTaskGraphFinalSummaryBinding(loaded)
    if (!binding) return null
    const counts = binding.summary.counts
    return {
      graphRevision: binding.graphRevision,
      counts: {
        discoveredJobs: copyCount(counts.discoveredJobs),
        analyzedJobs: copyCount(counts.analyzedJobs),
        artifactReferences: copyCount(counts.artifactReferences),
        reviewOutcomes: copyCount(counts.reviewOutcomes),
      },
    }
  } catch {
    return null
  }
}

function copyCount(count: TaskGraphFinalSummary["counts"]["discoveredJobs"]): TaskGraphFinalSummary["counts"]["discoveredJobs"] {
  return { knownCount: count.knownCount, coverage: count.coverage }
}
