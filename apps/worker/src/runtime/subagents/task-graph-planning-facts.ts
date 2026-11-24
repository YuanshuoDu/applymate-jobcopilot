import { buildTaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { currentTaskGraph } from "./task-graph-pg-current-node.js"

export type TaskGraphPlanningFacts = Readonly<{
  graphRevision: number
  counts: TaskGraphFinalSummary["counts"]
  scoutOverlap?: TaskGraphScoutOverlap
}>

export type TaskGraphScoutOverlap = Readonly<{
  coverage: TaskGraphFinalSummary["counts"]["discoveredJobs"]["coverage"]
  scouts: readonly Readonly<{
    key: string
    taskStatus: GraphTaskRow["status"]
    resultStatus: "completed" | "partial" | null
    resultCoverage: "complete" | "partial" | "unavailable"
    reportedCount: number | null
    sharedCount: number | null
  }>[]
}>

/** Projects bounded aggregate counts and Scout overlap from the already loaded current graph. */
export function buildTaskGraphPlanningFacts(loaded: LoadedGraph): TaskGraphPlanningFacts | null {
  const hasSnapshotMarker = loaded.snapshot ? Object.hasOwn(loaded.snapshot, "objectiveTailor") : false
  const hasStateMarker = loaded.state ? Object.hasOwn(loaded.state, "objectiveTailor") : false
  if (hasSnapshotMarker !== hasStateMarker) throw new Error("task_graph_objective_tailor_current_invalid")
  if (hasSnapshotMarker && loaded.discoveryTurnEligibility !== "ordinary") {
    throw new Error("task_graph_objective_tailor_current_invalid")
  }
  const marker = hasSnapshotMarker ? currentTaskGraph(loaded).objectiveTailor : undefined
  if (hasSnapshotMarker && !marker) throw new Error("task_graph_objective_tailor_current_invalid")
  const planningLoaded = marker ? sourcePrefixLoadedGraph(loaded, marker.sourceNodeCount) : loaded
  const binding = buildTaskGraphFinalSummaryBinding(planningLoaded)
  if (!binding) return null
  const counts = binding.summary.counts
  return {
    graphRevision: binding.graphRevision,
    scoutOverlap: buildScoutOverlapFacts(planningLoaded, binding.summary),
    counts: {
      discoveredJobs: copyCount(counts.discoveredJobs),
      analyzedJobs: copyCount(counts.analyzedJobs),
      prepareJobs: copyCount(counts.prepareJobs),
      artifactReferences: marker ? unavailableCount() : copyCount(counts.artifactReferences),
      reviewOutcomes: marker ? unavailableCount() : copyCount(counts.reviewOutcomes),
    },
  }
}

function sourcePrefixLoadedGraph(loaded: LoadedGraph, sourceNodeCount: number): LoadedGraph {
  if (!loaded.item || !loaded.snapshot || !loaded.state || sourceNodeCount < 2 || sourceNodeCount >= loaded.snapshot.nodes.length) {
    throw new Error("task_graph_objective_tailor_current_invalid")
  }
  const nodeIds = new Set(loaded.snapshot.nodes.slice(0, sourceNodeCount).map(node => node.taskId))
  const { objectiveTailor: _snapshotMarker, ...snapshot } = loaded.snapshot
  const { objectiveTailor: _stateMarker, ...state } = loaded.state
  return { ...loaded, snapshot: { ...snapshot, nodes: snapshot.nodes.slice(0, sourceNodeCount) },
    state: { ...state, nodes: state.nodes.slice(0, sourceNodeCount) },
    tasks: new Map([...loaded.tasks].filter(([taskId]) => nodeIds.has(taskId))) }
}

function buildScoutOverlapFacts(loaded: LoadedGraph, summary: TaskGraphFinalSummary): TaskGraphScoutOverlap {
  const nodes = loaded.snapshot?.nodes
  if (!nodes) throw new Error("task_graph_final_summary_graph_invalid")
  const outcomes = new Map(summary.taskOutcomes.map(outcome => [outcome.taskId, outcome] as const))
  const scouts = nodes.flatMap(node => {
    const task = loaded.tasks.get(node.taskId)
    if (!task || task.id !== node.taskId) throw new Error("task_graph_final_summary_task_scope_invalid")
    if (node.templateId !== "scout") return []
    if (task.role !== "scout") throw new Error("task_graph_final_summary_task_scope_invalid")
    const outcome = outcomes.get(node.taskId)
    const resultStatus = outcome?.resultState === "valid" ? outcome.roleResultStatus ?? null : null
    const resultCoverage: TaskGraphScoutOverlap["scouts"][number]["resultCoverage"] = resultStatus === "completed" ? "complete"
      : resultStatus === "partial" ? "partial" : "unavailable"
    return [{ node, taskStatus: task.status, resultStatus, resultCoverage }]
  })
  const availableTaskIds = new Set(scouts.filter(scout => scout.resultStatus !== null).map(scout => scout.node.taskId))
  const reportedIdsByTask = new Map<string, Set<string>>()
  const availableTaskIdsByJob = new Map<string, Set<string>>()
  for (const report of summary.discoveredJobs) {
    const availableReporters = new Set(report.taskIds.filter(taskId => availableTaskIds.has(taskId)))
    if (availableReporters.size > 0) availableTaskIdsByJob.set(report.jobId, availableReporters)
    for (const taskId of availableReporters) {
      let reportedIds = reportedIdsByTask.get(taskId)
      if (!reportedIds) reportedIdsByTask.set(taskId, reportedIds = new Set())
      reportedIds.add(report.jobId)
    }
  }
  const rows = scouts.map(scout => {
    if (scout.resultStatus === null) return {
      key: scout.node.key, taskStatus: scout.taskStatus, resultStatus: null,
      resultCoverage: "unavailable" as const, reportedCount: null, sharedCount: null,
    }
    const reportedIds = reportedIdsByTask.get(scout.node.taskId) ?? new Set<string>()
    let sharedCount = 0
    for (const jobId of reportedIds) {
      const reporters = availableTaskIdsByJob.get(jobId)
      if (reporters && [...reporters].some(taskId => taskId !== scout.node.taskId)) sharedCount++
    }
    return {
      key: scout.node.key, taskStatus: scout.taskStatus, resultStatus: scout.resultStatus,
      resultCoverage: scout.resultCoverage, reportedCount: reportedIds.size, sharedCount,
    }
  })
  const available = rows.filter(scout => scout.resultStatus !== null)
  const coverage = rows.length === 0 ? "not_requested"
    : available.length === 0 ? "unavailable"
      : rows.some(scout => scout.taskStatus !== "completed" || scout.resultCoverage !== "complete") ? "partial" : "complete"
  return { coverage, scouts: rows }
}

function copyCount(count: TaskGraphFinalSummary["counts"]["discoveredJobs"]): TaskGraphFinalSummary["counts"]["discoveredJobs"] {
  return { knownCount: count.knownCount, coverage: count.coverage }
}
function unavailableCount(): TaskGraphFinalSummary["counts"]["artifactReferences"] {
  return { knownCount: null, coverage: "unavailable" }
}
