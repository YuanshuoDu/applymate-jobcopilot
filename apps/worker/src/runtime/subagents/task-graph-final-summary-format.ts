import type { TaskGraphFinalSummary, TaskGraphSummaryCount } from "./task-graph-final-summary.js"

const MAX_SUMMARY_CHARS = 1_000
const METRICS = [
  ["discovered jobs", "discoveredJobs"],
  ["analyzed jobs", "analyzedJobs"],
  ["artifact references", "artifactReferences"],
  ["review outcomes", "reviewOutcomes"],
] as const

/** Formats only fixed category labels, task-reported counts, and their coverage. */
export function formatTaskGraphFinalSummary(summary: TaskGraphFinalSummary): string {
  const counts: unknown = summary && summary.counts
  const record = counts && typeof counts === "object" ? counts as Record<string, unknown> : null
  const metrics = METRICS.map(([label, key]) => `${label}: ${formatCount(record?.[key])}`)
  return `Task-reported results: ${metrics.join("; ")}.`.slice(0, MAX_SUMMARY_CHARS)
}

function formatCount(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unavailable"
  const count = value as Partial<TaskGraphSummaryCount>
  if (count.coverage === "not_requested" && count.knownCount === null) return "not requested"
  if (count.coverage === "unavailable" && count.knownCount === null) return "unavailable"
  if ((count.coverage === "complete" || count.coverage === "partial")
    && typeof count.knownCount === "number" && Number.isSafeInteger(count.knownCount) && count.knownCount >= 0) {
    return count.coverage === "partial" ? `${count.knownCount} observed (partial)` : `${count.knownCount} (complete)`
  }
  return "unavailable"
}
