import type { TaskGraphFinalSummary, TaskGraphSummaryCount } from "./task-graph-final-summary.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"

const MAX_SUMMARY_CHARS = 1_000
const MAX_SUMMARY_BYTES = 1_000
const MAX_PREPARE_JOBS_PER_RESULT = 50
const METRICS = [
  ["discovered jobs", "discoveredJobs"],
  ["analyzed jobs", "analyzedJobs"],
  ["Prepare outcome records", "prepareJobs"],
  ["artifact references", "artifactReferences"],
  ["review outcomes", "reviewOutcomes"],
] as const
const ROLES = ["analyst", "prepare", "reviewer", "scout", "unsupported", "writer"] as const
const TASK_STATUSES = ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"] as const
const RESULT_STATES = ["valid", "missing", "invalid", "unsupported_role", "not_terminal"] as const
const REPORTED_STATUSES = ["completed", "partial"] as const
const REPORTED_STATUS_ORDER = ["not reported", ...REPORTED_STATUSES] as const
const PREPARE_JOB_STATUSES = ["prepared", "skipped", "failed"] as const
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}(?![\s\S])/

type Outcome = Readonly<{
  role: typeof ROLES[number]
  taskStatus: typeof TASK_STATUSES[number]
  resultState: typeof RESULT_STATES[number]
  reportedStatus: typeof REPORTED_STATUSES[number] | "not reported"
}>

/** Formats fixed count labels and allowlisted task facts without task-level payload data. */
export function formatTaskGraphFinalSummary(summary: TaskGraphFinalSummary): string {
  const counts: unknown = summary && summary.counts
  const record = counts && typeof counts === "object" ? counts as Record<string, unknown> : null
  const metrics = METRICS.map(([label, key]) => `${label}: ${formatCount(record?.[key])}`)
  const countSummary = `Task-reported results: ${metrics.join("; ")}.`
  const prepareBreakdown = prepareOutcomeBreakdown(summary?.prepareResults, record?.prepareJobs)
  const baseSummary = prepareBreakdown ? appendPrepareBreakdown(countSummary, prepareBreakdown) : countSummary
  return appendTaskOutcomes(baseSummary, summary?.taskOutcomes, counts)
}

function appendPrepareBreakdown(base: string, breakdown: string): string {
  const candidate = `${base} ${breakdown}`
  if (withinLimits(candidate)) return candidate
  return appendWithinLimit(base, " Prepare status breakdown omitted to keep the summary within limits.")
}

function prepareOutcomeBreakdown(results: unknown, countValue: unknown): string | null {
  const count = asRecord(countValue)
  if (!count) return "Prepare status breakdown unavailable."
  const resultsAreEmpty = isDenseArray(results, TASK_GRAPH_LIMITS.maxNodes) && results.length === 0
  if ((count.coverage === "not_requested" || count.coverage === "unavailable") && count.knownCount === null) {
    return resultsAreEmpty ? null : "Prepare status breakdown unavailable."
  }
  if ((count.coverage !== "complete" && count.coverage !== "partial")
    || typeof count.knownCount !== "number" || !Number.isSafeInteger(count.knownCount) || count.knownCount < 0) {
    return "Prepare status breakdown unavailable."
  }

  const observed = summarizePrepareResults(results)
  if (!observed || observed.total !== count.knownCount || count.coverage === "complete" && observed.hasPartialResult) {
    return "Prepare status breakdown unavailable."
  }
  return `Prepare-reported outcome records (observed per task; repeated jobs may count separately; submission not verified): prepared=${observed.prepared}, skipped=${observed.skipped}, failed=${observed.failed}.`
}

function summarizePrepareResults(value: unknown): Readonly<{ prepared: number; skipped: number; failed: number; total: number; hasPartialResult: boolean }> | null {
  if (!isDenseArray(value, TASK_GRAPH_LIMITS.maxNodes) || value.length === 0) return null
  const seenTaskIds = new Set<string>()
  const counts = { prepared: 0, skipped: 0, failed: 0, total: 0, hasPartialResult: false }
  for (const candidate of value) {
    const result = asRecord(candidate)
    if (!result || typeof result.taskId !== "string" || !SAFE_IDENTIFIER.test(result.taskId) || seenTaskIds.has(result.taskId)
      || !isOneOf(result.resultStatus, REPORTED_STATUSES) || !isDenseArray(result.jobs, MAX_PREPARE_JOBS_PER_RESULT)) return null
    seenTaskIds.add(result.taskId)
    const seenJobIds = new Set<string>()
    let hasFailure = false
    for (const candidateJob of result.jobs) {
      const job = asRecord(candidateJob)
      if (!job || typeof job.jobId !== "string" || !SAFE_IDENTIFIER.test(job.jobId) || seenJobIds.has(job.jobId)
        || !isOneOf(job.status, PREPARE_JOB_STATUSES)) return null
      seenJobIds.add(job.jobId)
      counts[job.status] += 1
      counts.total += 1
      if (job.status === "failed") hasFailure = true
    }
    if ((result.resultStatus === "partial") !== hasFailure) return null
    if (result.resultStatus === "partial") counts.hasPartialResult = true
  }
  return counts
}

function isDenseArray(value: unknown, maxItems: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1
    && keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}

function appendTaskOutcomes(baseSummary: string, taskOutcomes: unknown, counts: unknown): string {
  if (!Array.isArray(taskOutcomes)) return appendWithinLimit(baseSummary, " Task outcome overview unavailable (invalid entries omitted).")
  if (taskOutcomes.length === 0) {
    const emptyNote = hasOnlyNotRequestedCounts(counts)
      ? " No business task outcomes recorded."
      : " Task outcome overview unavailable (inconsistent summary)."
    return appendWithinLimit(baseSummary, emptyNote)
  }

  const groups = new Map<string, { outcome: Outcome; count: number }>()
  let invalidEntries = 0
  for (const candidate of taskOutcomes) {
    const outcome = parseOutcome(candidate)
    if (!outcome) {
      invalidEntries += 1
      continue
    }
    const key = outcomeKey(outcome)
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { outcome, count: 1 })
  }
  if (groups.size === 0) return appendWithinLimit(baseSummary, " Task outcome overview unavailable (invalid entries omitted).")

  const orderedGroups = [...groups.values()].sort((left, right) => compareOutcomes(left.outcome, right.outcome))
  const invalidNote = invalidEntries > 0 ? "; invalid entries omitted" : ""
  const prefix = ` Recorded task outcomes (earlier attempts may be superseded; not verification${invalidNote}):`
  const renderedGroups = orderedGroups.map(({ outcome, count }) => renderGroup(outcome, count))
  let included = 0
  let result = ""
  for (let index = 0; index <= renderedGroups.length; index += 1) {
    const omitted = renderedGroups.length - index
    const omissionNote = omitted > 0 ? `; ${omitted} outcome group${omitted === 1 ? "" : "s"} omitted` : ""
    const candidate = `${baseSummary}${prefix}${index > 0 ? ` ${renderedGroups.slice(0, index).join("; ")}` : ""}${omissionNote}.`
    if (!withinLimits(candidate)) break
    included = index
    result = candidate
  }
  if (included < renderedGroups.length && result) return result
  if (included === renderedGroups.length && result) return result
  return appendWithinLimit(baseSummary, " Task outcome overview omitted to keep the summary within limits.")
}

function hasOnlyNotRequestedCounts(value: unknown): boolean {
  const record = asRecord(value)
  return !!record && METRICS.every(([, key]) => {
    const count = asRecord(record[key])
    return !!count && count.knownCount === null && count.coverage === "not_requested"
  })
}

function parseOutcome(value: unknown): Outcome | null {
  const row = asRecord(value)
  if (!row || !isOneOf(row.role, ROLES) || !isOneOf(row.taskStatus, TASK_STATUSES) || !isOneOf(row.resultState, RESULT_STATES)) return null
  const hasReportedStatus = Object.hasOwn(row, "roleResultStatus")
  let reportedStatus: Outcome["reportedStatus"] = "not reported"
  if (hasReportedStatus) {
    const value = row.roleResultStatus
    if (!isOneOf(value, REPORTED_STATUSES)) return null
    reportedStatus = value
  }
  if (row.resultState === "unsupported_role" ? row.role !== "unsupported" : row.role === "unsupported") return null
  if (row.resultState === "not_terminal" && TERMINAL_STATUSES.has(row.taskStatus)) return null
  if ((row.resultState === "valid" || row.resultState === "missing" || row.resultState === "invalid")
    && !TERMINAL_STATUSES.has(row.taskStatus)) return null
  if (row.resultState === "valid" ? !hasReportedStatus : hasReportedStatus) return null
  return {
    role: row.role,
    taskStatus: row.taskStatus,
    resultState: row.resultState,
    reportedStatus,
  }
}

function renderGroup(outcome: Outcome, count: number): string {
  return `role=${outcome.role}, task state=${outcome.taskStatus}, result structure=${outcome.resultState}, reported result status=${outcome.reportedStatus}: ${count}`
}

function compareOutcomes(left: Outcome, right: Outcome): number {
  return ROLES.indexOf(left.role) - ROLES.indexOf(right.role)
    || TASK_STATUSES.indexOf(left.taskStatus) - TASK_STATUSES.indexOf(right.taskStatus)
    || RESULT_STATES.indexOf(left.resultState) - RESULT_STATES.indexOf(right.resultState)
    || REPORTED_STATUS_ORDER.indexOf(left.reportedStatus) - REPORTED_STATUS_ORDER.indexOf(right.reportedStatus)
}

function outcomeKey(outcome: Outcome): string {
  return `${outcome.role}|${outcome.taskStatus}|${outcome.resultState}|${outcome.reportedStatus}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.some(candidate => candidate === value)
}

function appendWithinLimit(base: string, suffix: string): string {
  const candidate = `${base}${suffix}`
  return withinLimits(candidate) ? candidate : base
}

function withinLimits(value: string): boolean {
  return value.length <= MAX_SUMMARY_CHARS && new TextEncoder().encode(value).byteLength <= MAX_SUMMARY_BYTES
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
