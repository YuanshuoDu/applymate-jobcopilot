import { buildTaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"

export type TaskGraphPlanningFacts = Readonly<{
  graphRevision: number
  counts: TaskGraphFinalSummary["counts"]
}>

const SUMMARY_SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const SUMMARY_TASK_STATUSES: ReadonlySet<string> = new Set([
  "queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed",
])

/** Projects only aggregate counts from the already loaded current graph. */
export function buildTaskGraphPlanningFacts(loaded: LoadedGraph): TaskGraphPlanningFacts | null {
  let binding: ReturnType<typeof buildTaskGraphFinalSummaryBinding>
  try {
    binding = buildTaskGraphFinalSummaryBinding(loaded)
  } catch (error) {
    if (error instanceof Error && error.message === "task_graph_final_summary_node_invalid"
      && hasReducerRejectedTaskIdOnly(loaded)) return null
    throw error
  }
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
}

function hasReducerRejectedTaskIdOnly(loaded: LoadedGraph): boolean {
  if (!loaded.snapshot) return false
  // The reducer's node error also covers role/status and duplicate IDs. Suppress it only when its stricter task-ID grammar is the sole invalid field.
  let hasRejectedTaskId = false
  const seenTaskIds = new Set<string>()
  for (const node of loaded.snapshot.nodes) {
    const task = loaded.tasks.get(node.taskId)
    if (seenTaskIds.has(node.taskId) || !task || typeof task.role !== "string" || !task.role.trim() || task.role.length > 64
      || !SUMMARY_TASK_STATUSES.has(task.status)) return false
    seenTaskIds.add(node.taskId)
    if (!SUMMARY_SAFE_TASK_ID.test(node.taskId)) hasRejectedTaskId = true
  }
  return hasRejectedTaskId
}

function copyCount(count: TaskGraphFinalSummary["counts"]["discoveredJobs"]): TaskGraphFinalSummary["counts"]["discoveredJobs"] {
  return { knownCount: count.knownCount, coverage: count.coverage }
}
