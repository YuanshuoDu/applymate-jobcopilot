import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { TaskGraphExecutionFailureCategory } from "./task-graph-failure-category.js"

const ROLE_LABELS = { analyst: "Analysis", prepare: "Preparation", reviewer: "Review", scout: "Search", writer: "Draft writing", unsupported: "Other" } as const
const TASK_STATES = ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"] as const
const RESULT_STATES = ["valid", "missing", "invalid", "unsupported_role", "not_terminal"] as const
const ROLES = ["analyst", "prepare", "reviewer", "scout", "writer", "unsupported"] as const
const REPORTED_STATUSES = ["completed", "partial"] as const
const FAILURE_CATEGORIES = ["execution_setup_unavailable", "resume_state_unavailable", "structured_output_invalid", "execution_deadline_exceeded"] as const

type TaskOutcome = TaskGraphFinalSummary["taskOutcomes"][number]
type OutcomeGroup = Readonly<{
  outcome: TaskOutcome
  count: number
  resolved: boolean
  failureCategory?: TaskGraphExecutionFailureCategory
}>

/** Renders only grouped status facts and the server-verified closed failure category. */
export function renderTaskGraphFinalOutcomeLines(
  value: unknown,
  resolvedRepairTaskIds: ReadonlySet<string>,
  failureOutcomes: ReadonlyMap<string, TaskGraphExecutionFailureCategory>,
): string[] {
  const rows = dense(value, TASK_GRAPH_LIMITS.maxPersistedNodes)
  if (!rows) return ["Task states: unavailable."]
  if (!rows.length) return ["Task states: no business tasks recorded."]
  const groups = new Map<string, { outcome: TaskOutcome; count: number; resolved: boolean; failureCategory?: TaskGraphExecutionFailureCategory }>()
  for (const candidate of rows) {
    const outcome = parseOutcome(candidate)
    if (!outcome) return ["Task states: unavailable."]
    const resolved = resolvedRepairTaskIds.has(outcome.taskId)
    const failureCategory = outcome.taskStatus === "failed" ? readFailureCategory(failureOutcomes.get(outcome.taskId)) : undefined
    const key = `${outcome.role}|${outcome.taskStatus}|${outcome.resultState}|${outcome.roleResultStatus ?? ""}|${resolved}|${failureCategory ?? ""}`
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { outcome, count: 1, resolved, ...(failureCategory ? { failureCategory } : {}) })
  }
  return ["Task states:", ...[...groups.values()].flatMap(renderOutcome)]
}

function renderOutcome(group: OutcomeGroup): string[] {
  const { outcome, count } = group
  const label = ROLE_LABELS[outcome.role]
  const task = `${count} ${taskState(outcome.taskStatus)} ${count === 1 ? "task" : "tasks"}`
  const result = outcome.resultState === "valid" ? `valid structured result reported ${outcome.roleResultStatus}`
    : outcome.resultState === "missing" ? "structured result missing"
      : outcome.resultState === "invalid" ? "structured result invalid"
        : outcome.resultState === "not_terminal" ? "no terminal structured result yet" : "task type omitted from result details"
  const status = `${label}: ${task}; ${result}.${group.resolved ? " Verified repair evidence covers the affected criteria." : ""}`
  if (!group.failureCategory) return [status]
  const cause = failureCause(group.failureCategory)
  const next = group.resolved ? "See the current verified results."
    : `Inspect current evidence for ${count === 1 ? "the affected task" : "the affected tasks"} before deciding what to do next.`
  return [status, `${group.resolved ? "Earlier execution issue" : "Execution blocker"}: ${cause} ${next}`]
}

function failureCause(value: TaskGraphExecutionFailureCategory): string {
  switch (value) {
    case "execution_setup_unavailable": return "Required setup or inputs were unavailable."
    case "resume_state_unavailable": return "Required resume state was unavailable."
    case "structured_output_invalid": return "The structured result did not satisfy its contract."
    case "execution_deadline_exceeded": return "The task exceeded its execution deadline."
  }
}

function taskState(value: TaskOutcome["taskStatus"]): string {
  return value === "waiting_for_user" ? "waiting for user" : value
}

function parseOutcome(value: unknown): TaskOutcome | null {
  if (!isRecord(value) || typeof value.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}(?![\s\S])/.test(value.taskId)
    || !isOneOf(value.role, ROLES) || !isOneOf(value.taskStatus, TASK_STATES) || !isOneOf(value.resultState, RESULT_STATES)) return null
  const hasStatus = Object.hasOwn(value, "roleResultStatus")
  if (value.resultState === "valid" ? !hasStatus || !isOneOf(value.roleResultStatus, REPORTED_STATUSES) : hasStatus) return null
  return value as TaskOutcome
}

function readFailureCategory(value: unknown): TaskGraphExecutionFailureCategory | undefined {
  return isOneOf(value, FAILURE_CATEGORIES) ? value : undefined
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
