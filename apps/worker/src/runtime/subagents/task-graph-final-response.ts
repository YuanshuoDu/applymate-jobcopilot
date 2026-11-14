import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { TaskGraphFinalSummary, TaskGraphSummaryCount } from "./task-graph-final-summary.js"

const MAX_RESPONSE_BYTES = 4_096
const MAX_ARTIFACT_ROWS = TASK_GRAPH_LIMITS.maxPersistedNodes * 102
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}(?![\s\S])/
const LIMITATION = "These are structured task reports, not independent verification. Prepared materials do not confirm that an application was submitted or received by an employer."
const ROLE_LABELS = { analyst: "Analysis", prepare: "Preparation", reviewer: "Review", scout: "Search", writer: "Draft writing", unsupported: "Other" } as const
const TASK_STATES = ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"] as const
const RESULT_STATES = ["valid", "missing", "invalid", "unsupported_role", "not_terminal"] as const
const ROLES = ["analyst", "prepare", "reviewer", "scout", "writer", "unsupported"] as const
const REPORTED_STATUSES = ["completed", "partial"] as const
const REVIEW_STATUSES = ["passed", "needs_revision", "rejected", "stale"] as const
type TaskOutcome = TaskGraphFinalSummary["taskOutcomes"][number]
type OutcomeGroup = Readonly<{ outcome: TaskOutcome; count: number }>

/** Renders only deterministic facts from the current private TaskGraph binding. */
export function buildGroundedTaskGraphFinalResponse(binding: TaskGraphFinalSummaryBinding): string {
  const summary = binding?.summary
  if (!summary || !Number.isSafeInteger(binding.graphRevision) || binding.graphRevision < 0 || summary.graphRevision !== binding.graphRevision) {
    return `Task-reported results are unavailable. ${LIMITATION}`
  }

  const discovered = safeJobRows(summary.discoveredJobs, "taskIds")
  const analyzed = safeJobRows(summary.analyzedJobs, "findings")
  const prepare = prepareRows(summary)
  const artifacts = artifactRows(summary.artifactReferences)
  const reviews = reviewRows(summary.reviewOutcomes)
  const lines = ["Task-reported results:"]
  lines.push(countLine("Search results", summary.counts?.discoveredJobs, discovered, ["unique job", "unique jobs"]))
  lines.push(countLine("Analysis results", summary.counts?.analyzedJobs, analyzed, ["unique job with findings", "unique jobs with findings"]))
  lines.push(countLine("Preparation outcomes", summary.counts?.prepareJobs, prepare?.total ?? null, ["job outcome record", "job outcome records"]))
  lines.push(countLine("Artifact references", summary.counts?.artifactReferences, artifacts, ["artifact reference", "artifact references"]))
  lines.push(countLine("Reviewer outcomes", summary.counts?.reviewOutcomes, reviews, ["review outcome", "review outcomes"]))
  const prepareDetail = prepareBreakdown(summary.counts?.prepareJobs, prepare)
  if (prepareDetail) lines.push(prepareDetail)
  const reviewDetail = reviewBreakdown(summary.counts?.reviewOutcomes, summary.reviewOutcomes, reviews)
  if (reviewDetail) lines.push(reviewDetail)
  lines.push(artifactDetail(summary.counts?.artifactReferences, artifacts))
  lines.push(...taskOutcomeLines(summary.taskOutcomes))
  lines.push(LIMITATION)
  return boundLines(lines)
}

function countLine(label: string, value: unknown, observed: number | null, units: readonly [string, string]): string {
  const count = readCount(value)
  if (!count || observed === null) return `${label}: unavailable (summary details are inconsistent).`
  if (count.coverage === "not_requested" && observed === 0) return `${label}: not requested.`
  if (count.coverage === "unavailable" && observed === 0) return `${label}: unavailable (no valid structured result).`
  if ((count.coverage !== "complete" && count.coverage !== "partial") || count.knownCount !== observed) {
    return `${label}: unavailable (summary details are inconsistent).`
  }
  const noun = observed === 1 ? units[0] : units[1]
  return `${label}: ${observed} ${noun} reported (${count.coverage} coverage).`
}

function prepareBreakdown(value: unknown, prepared: ReturnType<typeof prepareRows>): string | null {
  const count = readCount(value)
  if (!count || !prepared) return "Preparation status details are unavailable."
  if (count.coverage === "not_requested" && prepared.total === 0) return null
  if (count.coverage === "unavailable" && prepared.total === 0) return null
  if ((count.coverage !== "complete" && count.coverage !== "partial") || count.knownCount !== prepared.total) return null
  return `Preparation statuses reported: prepared ${prepared.prepared}, skipped ${prepared.skipped}, failed ${prepared.failed}. These records may repeat a job across tasks and do not count applications or submissions.`
}

function reviewBreakdown(countValue: unknown, value: unknown, observed: number | null): string | null {
  const count = readCount(countValue)
  if (!count || observed === null || (count.coverage !== "complete" && count.coverage !== "partial") || count.knownCount !== observed) return null
  const statuses = { passed: 0, needs_revision: 0, rejected: 0, stale: 0 }
  for (const row of dense(value, MAX_ARTIFACT_ROWS) ?? []) {
    if (!isRecord(row) || !isOneOf(row.reviewStatus, REVIEW_STATUSES)) return null
    statuses[row.reviewStatus] += 1
  }
  const details = `passed ${statuses.passed}, needs revision ${statuses.needs_revision}, rejected ${statuses.rejected}, stale ${statuses.stale}`
  return `Reviewer tasks reported ${details}${count.coverage === "partial" ? " among observed outcomes" : ""}. These are reviewer task reports, not independent verification.`
}

function artifactDetail(value: unknown, observed: number | null): string {
  const count = readCount(value)
  if (!count || observed === null || count.coverage === "unavailable" || count.coverage === "not_requested") return ""
  if ((count.coverage !== "complete" && count.coverage !== "partial") || count.knownCount !== observed) return ""
  return observed > 0 ? "See structured task details for the available artifact version references." : ""
}

function taskOutcomeLines(value: unknown): string[] {
  const rows = dense(value, TASK_GRAPH_LIMITS.maxPersistedNodes)
  if (!rows) return ["Task states: unavailable."]
  if (!rows.length) return ["Task states: no business tasks recorded."]
  const groups = new Map<string, { outcome: TaskOutcome; count: number }>()
  for (const candidate of rows) {
    const outcome = parseOutcome(candidate)
    if (!outcome) return ["Task states: unavailable."]
    const key = `${outcome.role}|${outcome.taskStatus}|${outcome.resultState}|${outcome.roleResultStatus ?? ""}`
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { outcome, count: 1 })
  }
  return ["Task states:", ...[...groups.values()].map(renderOutcome)]
}

function renderOutcome(group: OutcomeGroup): string {
  const { outcome, count } = group
  const label = ROLE_LABELS[outcome.role]
  const task = `${count} ${taskState(outcome.taskStatus)} ${count === 1 ? "task" : "tasks"}`
  const result = outcome.resultState === "valid" ? `valid structured result reported ${outcome.roleResultStatus}`
    : outcome.resultState === "missing" ? "structured result missing"
      : outcome.resultState === "invalid" ? "structured result invalid"
        : outcome.resultState === "not_terminal" ? "no terminal structured result yet" : "task type omitted from result details"
  return `${label}: ${task}; ${result}.`
}

function taskState(value: TaskOutcome["taskStatus"]): string {
  return value === "waiting_for_user" ? "waiting for user" : value
}

function parseOutcome(value: unknown): TaskOutcome | null {
  if (!isRecord(value) || typeof value.taskId !== "string" || !SAFE_IDENTIFIER.test(value.taskId)
    || !isOneOf(value.role, ROLES) || !isOneOf(value.taskStatus, TASK_STATES) || !isOneOf(value.resultState, RESULT_STATES)) return null
  const hasStatus = Object.hasOwn(value, "roleResultStatus")
  if (value.resultState === "valid" ? !hasStatus || !isOneOf(value.roleResultStatus, REPORTED_STATUSES) : hasStatus) return null
  return value as TaskOutcome
}

function safeJobRows(value: unknown, detailKey: "taskIds" | "findings"): number | null {
  const rows = dense(value, MAX_ARTIFACT_ROWS)
  if (!rows) return null
  for (const row of rows) {
    if (!isRecord(row) || typeof row.jobId !== "string" || !SAFE_IDENTIFIER.test(row.jobId)) return null
    const detail = dense(row[detailKey], TASK_GRAPH_LIMITS.maxPersistedNodes * 100)
    if (!detail || detail.some(item => detailKey === "taskIds"
      ? typeof item !== "string" || !SAFE_IDENTIFIER.test(item)
      : !isRecord(item) || typeof item.taskId !== "string" || !SAFE_IDENTIFIER.test(item.taskId) || typeof item.score !== "number" || !Number.isFinite(item.score))) return null
  }
  return rows.length
}

function prepareRows(summary: TaskGraphFinalSummary): Readonly<{ prepared: number; skipped: number; failed: number; total: number }> | null {
  const rows = dense(summary.prepareResults, TASK_GRAPH_LIMITS.maxPersistedNodes)
  if (!rows) return null
  const counts = { prepared: 0, skipped: 0, failed: 0, total: 0 }
  for (const row of rows) {
    if (!isRecord(row) || typeof row.taskId !== "string" || !SAFE_IDENTIFIER.test(row.taskId)
      || !isOneOf(row.resultStatus, REPORTED_STATUSES)) return null
    const jobs = dense(row.jobs, 50)
    if (!jobs) return null
    let hasFailure = false
    for (const job of jobs) {
      if (!isRecord(job) || typeof job.jobId !== "string" || !SAFE_IDENTIFIER.test(job.jobId)
        || !isOneOf(job.status, ["prepared", "skipped", "failed"] as const)) return null
      counts[job.status] += 1
      counts.total += 1
      if (job.status === "failed") hasFailure = true
    }
    if ((row.resultStatus === "partial") !== hasFailure) return null
  }
  return counts
}

function artifactRows(value: unknown): number | null {
  const rows = dense(value, MAX_ARTIFACT_ROWS)
  return rows && rows.every(row => isRecord(row) && artifactReference(row.artifactRef) && safeIds(row.taskIds)) ? rows.length : null
}

function reviewRows(value: unknown): number | null {
  const rows = dense(value, MAX_ARTIFACT_ROWS)
  return rows && rows.every(row => isRecord(row) && artifactReference(row.artifactRef) && safeIds(row.taskIds)
    && isOneOf(row.reviewStatus, REVIEW_STATUSES)) ? rows.length : null
}

function artifactReference(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.artifactId === "string" && SAFE_IDENTIFIER.test(value.artifactId)
    && Number.isSafeInteger(value.version) && Number(value.version) > 0
    && typeof value.contentHash === "string" && /^sha256:[a-f0-9]{64}$/.test(value.contentHash)
    && typeof value.sourceDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.sourceDigest)
}

function safeIds(value: unknown): boolean {
  const rows = dense(value, TASK_GRAPH_LIMITS.maxPersistedNodes)
  return !!rows && rows.every(item => typeof item === "string" && SAFE_IDENTIFIER.test(item))
}

function readCount(value: unknown): TaskGraphSummaryCount | null {
  if (!isRecord(value) || !["complete", "partial", "unavailable", "not_requested"].includes(String(value.coverage))) return null
  if (value.knownCount !== null && (!Number.isSafeInteger(value.knownCount) || Number(value.knownCount) < 0)) return null
  const coverage = value.coverage
  if ((coverage === "complete" || coverage === "partial") !== (typeof value.knownCount === "number")) return null
  return value as TaskGraphSummaryCount
}

function dense(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null
  return Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value)
}

function boundLines(lines: readonly string[]): string {
  const full = lines.join("\n")
  if (new TextEncoder().encode(full).byteLength <= MAX_RESPONSE_BYTES) return full
  const footer = lines[lines.length - 1] ?? LIMITATION
  const selected = [lines[0] ?? "Task-reported results:"]
  for (const line of lines.slice(1, -1)) {
    const candidate = [...selected, line, "Additional task details omitted to keep this response within limits.", footer].join("\n")
    if (new TextEncoder().encode(candidate).byteLength > MAX_RESPONSE_BYTES) break
    selected.push(line)
  }
  return [...selected, "Additional task details omitted to keep this response within limits.", footer].join("\n")
}
