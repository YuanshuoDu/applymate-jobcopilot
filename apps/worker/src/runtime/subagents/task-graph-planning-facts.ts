import { buildTaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"

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
  const binding = buildTaskGraphFinalSummaryBinding(loaded)
  if (!binding) return null
  const counts = binding.summary.counts
  return {
    graphRevision: binding.graphRevision,
    scoutOverlap: buildScoutOverlapFacts(loaded, binding.summary),
    counts: {
      discoveredJobs: copyCount(counts.discoveredJobs),
      analyzedJobs: copyCount(counts.analyzedJobs),
      prepareJobs: copyCount(counts.prepareJobs),
      artifactReferences: copyCount(counts.artifactReferences),
      reviewOutcomes: copyCount(counts.reviewOutcomes),
    },
  }
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
