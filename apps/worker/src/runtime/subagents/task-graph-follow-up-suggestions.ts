import type { ArtifactVersionReference } from "./role-results.js"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import { validateTaskGraphFollowUpBinding } from "./task-graph-follow-up-validation.js"

const ROLES = ["analyst", "prepare", "reviewer", "scout", "writer", "unsupported"] as const
const TASK_STATES = ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"] as const
const RESULT_STATES = ["valid", "missing", "invalid", "unsupported_role", "not_terminal"] as const
const REVIEWS = ["passed", "needs_revision", "rejected", "stale"] as const
type ResultKind = "search" | "analysis" | "preparation" | "materials"
type Outcome = TaskGraphFinalSummary["taskOutcomes"][number]
type ResultRow = { taskId: string; resultKind: ResultKind; jobIds: Set<string>; artifactRefs: Map<string, ArtifactVersionReference> }

export type TaskGraphFollowUpSuggestion =
  | Readonly<{ kind: "inspect_task_result"; taskId: string; role: typeof ROLES[number]; taskStatus: typeof TASK_STATES[number]; resultState: typeof RESULT_STATES[number] }>
  | Readonly<{ kind: "inspect_material_review"; taskIds: readonly string[]; artifactRef: ArtifactVersionReference; reviewStatus: Exclude<typeof REVIEWS[number], "passed"> }>
  | Readonly<{ kind: "view_reported_results"; taskId: string; resultKind: ResultKind; jobIds: readonly string[]; artifactRefs: readonly ArtifactVersionReference[] }>

/** Derives optional, bounded advice from a complete private current-summary binding. */
export function reduceTaskGraphFollowUpSuggestions(binding: TaskGraphFinalSummaryBinding): readonly TaskGraphFollowUpSuggestion[] {
  try {
    const facts = validateTaskGraphFollowUpBinding(binding)
    if (!facts) return []
    const suggestions: TaskGraphFollowUpSuggestion[] = []
    for (const outcome of facts.outcomes.values()) {
      if (outcome.taskStatus !== "completed" || outcome.resultState !== "valid" || outcome.roleResultStatus === "partial") {
        suggestions.push({ kind: "inspect_task_result", taskId: outcome.taskId, role: outcome.role, taskStatus: outcome.taskStatus, resultState: outcome.resultState })
      }
    }
    const reviewStates = new Map<string, Set<string>>()
    for (const row of facts.summary.reviewOutcomes) {
      const refKey = artifactKey(row.artifactRef), states = reviewStates.get(refKey) ?? new Set<string>()
      states.add(row.reviewStatus); reviewStates.set(refKey, states)
    }
    const conflicted = new Set([...reviewStates].filter(([, states]) => states.size > 1).map(([ref]) => ref))
    for (const row of facts.summary.reviewOutcomes) {
      if (row.reviewStatus !== "passed" && !conflicted.has(artifactKey(row.artifactRef))) {
        suggestions.push({ kind: "inspect_material_review", artifactRef: row.artifactRef,
          reviewStatus: row.reviewStatus, taskIds: [...row.taskIds].sort(compareText) })
      }
    }
    const resultRows = new Map<string, ResultRow>()
    const addResult = (taskId: string, resultKind: ResultKind, jobId?: string, ref?: ArtifactVersionReference) => {
      const id = resultKind + ":" + taskId
      const row = resultRows.get(id) ?? { taskId, resultKind, jobIds: new Set<string>(), artifactRefs: new Map<string, ArtifactVersionReference>() }
      if (jobId) row.jobIds.add(jobId)
      if (ref) row.artifactRefs.set(artifactKey(ref), ref)
      resultRows.set(id, row)
    }
    for (const row of facts.summary.discoveredJobs) for (const taskId of row.taskIds) addResult(taskId, "search", row.jobId)
    for (const row of facts.summary.analyzedJobs) for (const finding of row.findings) addResult(finding.taskId, "analysis", row.jobId)
    for (const row of facts.summary.prepareResults) for (const job of row.jobs) addResult(row.taskId, "preparation", job.jobId)
    for (const row of facts.summary.artifactReferences) for (const taskId of row.taskIds) {
      const role = facts.outcomes.get(taskId)?.role
      if (role === "prepare") addResult(taskId, "preparation", undefined, row.artifactRef)
      else if (role === "writer" || role === "reviewer") addResult(taskId, "materials", undefined, row.artifactRef)
    }
    for (const row of resultRows.values()) {
      if (row.jobIds.size || row.artifactRefs.size) suggestions.push({ kind: "view_reported_results", taskId: row.taskId, resultKind: row.resultKind,
        jobIds: [...row.jobIds].sort(compareText), artifactRefs: [...row.artifactRefs.values()].sort(compareArtifact) })
    }
    return uniqueVisibleSuggestions(suggestions)
  } catch { return [] }
}

function uniqueVisibleSuggestions(suggestions: readonly TaskGraphFollowUpSuggestion[]): readonly TaskGraphFollowUpSuggestion[] {
  const seen = new Set<string>(), selected: TaskGraphFollowUpSuggestion[] = []
  for (const suggestion of [...suggestions].sort(compareSuggestions)) {
    const identity = suggestion.kind === "inspect_task_result" ? suggestion.kind + ":" + suggestion.role
      : suggestion.kind === "inspect_material_review" ? suggestion.kind + ":" + suggestion.reviewStatus
        : suggestion.kind + ":" + suggestion.resultKind
    if (seen.has(identity)) continue
    seen.add(identity); selected.push(suggestion)
    if (selected.length === 3) break
  }
  return selected
}

function artifactKey(ref: ArtifactVersionReference): string { return JSON.stringify([ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest]) }
function compareArtifact(a: ArtifactVersionReference, b: ArtifactVersionReference): number { return compareText(a.artifactId, b.artifactId) || a.version - b.version || compareText(a.contentHash, b.contentHash) || compareText(a.sourceDigest, b.sourceDigest) }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function key(value: TaskGraphFollowUpSuggestion): string { return JSON.stringify(value) }
function compareSuggestions(a: TaskGraphFollowUpSuggestion, b: TaskGraphFollowUpSuggestion): number {
  const rank = { inspect_task_result: 0, inspect_material_review: 1, view_reported_results: 2 }
  const aKey = a.kind === "inspect_task_result" ? a.taskId : a.kind === "inspect_material_review" ? artifactKey(a.artifactRef) : a.resultKind + ":" + a.taskId
  const bKey = b.kind === "inspect_task_result" ? b.taskId : b.kind === "inspect_material_review" ? artifactKey(b.artifactRef) : b.resultKind + ":" + b.taskId
  return rank[a.kind] - rank[b.kind] || compareText(aKey, bKey) || compareText(key(a), key(b))
}

