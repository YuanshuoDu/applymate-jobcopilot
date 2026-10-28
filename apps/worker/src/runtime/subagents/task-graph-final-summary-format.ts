import type { TaskGraphFinalSummary, TaskGraphSummaryCount } from "./task-graph-final-summary.js"

const MAX_SUMMARY_CHARS = 1_000
const MAX_SUMMARY_BYTES = 1_000
const METRICS = [
  ["discovered jobs", "discoveredJobs"],
  ["analyzed jobs", "analyzedJobs"],
  ["prepared jobs", "prepareJobs"],
  ["artifact references", "artifactReferences"],
  ["review outcomes", "reviewOutcomes"],
] as const
const ROLES = ["analyst", "prepare", "reviewer", "scout", "unsupported", "writer"] as const
const TASK_STATUSES = ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"] as const
const RESULT_STATES = ["valid", "missing", "invalid", "unsupported_role", "not_terminal"] as const
const REPORTED_STATUSES = ["completed", "partial"] as const
const REPORTED_STATUS_ORDER = ["not reported", ...REPORTED_STATUSES] as const
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])

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
  return appendTaskOutcomes(countSummary, summary?.taskOutcomes, counts)
}

function appendTaskOutcomes(countSummary: string, taskOutcomes: unknown, counts: unknown): string {
  if (!Array.isArray(taskOutcomes)) return appendWithinLimit(countSummary, " Task outcome overview unavailable (invalid entries omitted).")
  if (taskOutcomes.length === 0) {
    const emptyNote = hasOnlyNotRequestedCounts(counts)
      ? " No business task outcomes recorded."
      : " Task outcome overview unavailable (inconsistent summary)."
    return appendWithinLimit(countSummary, emptyNote)
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
  if (groups.size === 0) return appendWithinLimit(countSummary, " Task outcome overview unavailable (invalid entries omitted).")

  const orderedGroups = [...groups.values()].sort((left, right) => compareOutcomes(left.outcome, right.outcome))
  const invalidNote = invalidEntries > 0 ? "; invalid entries omitted" : ""
  const prefix = ` Recorded task outcomes (earlier attempts may be superseded; not verification${invalidNote}):`
  const renderedGroups = orderedGroups.map(({ outcome, count }) => renderGroup(outcome, count))
  let included = 0
  let result = ""
  for (let index = 0; index <= renderedGroups.length; index += 1) {
    const omitted = renderedGroups.length - index
    const omissionNote = omitted > 0 ? `; ${omitted} outcome group${omitted === 1 ? "" : "s"} omitted` : ""
    const candidate = `${countSummary}${prefix}${index > 0 ? ` ${renderedGroups.slice(0, index).join("; ")}` : ""}${omissionNote}.`
    if (!withinLimits(candidate)) break
    included = index
    result = candidate
  }
  if (included < renderedGroups.length && result) return result
  if (included === renderedGroups.length && result) return result
  return appendWithinLimit(countSummary, " Task outcome overview omitted to keep the summary within limits.")
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
