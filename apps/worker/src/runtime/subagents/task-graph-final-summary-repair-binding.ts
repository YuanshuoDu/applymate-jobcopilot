import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { validateTaskGraphFollowUpBinding } from "./task-graph-follow-up-validation.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"

type RepairSummaryMember = Readonly<{ kind: string; taskId: string; taskStatus: string }>

/** Binds only bounded failed business-member IDs to their reduced summary. */
export function normalizeResolvedRepairTaskIds(
  value: ReadonlySet<string> | undefined,
  members: readonly RepairSummaryMember[],
  summary: Pick<TaskGraphFinalSummary, "taskOutcomes">,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  try {
    if (!value || typeof value !== "object" || typeof value[Symbol.iterator] !== "function") return undefined
    const failed = new Set(summary.taskOutcomes.filter(outcome => outcome.taskStatus === "failed").map(outcome => outcome.taskId))
    const business = new Set(members.filter(member => member.kind === "business" && member.taskStatus === "failed").map(member => member.taskId))
    const ids = new Set<string>()
    let visited = 0
    for (const id of value) {
      if (++visited > TASK_GRAPH_LIMITS.maxPersistedNodes) return undefined
      if (safeTaskId(id) && business.has(id) && failed.has(id)) ids.add(id)
    }
    return ids.size ? [...ids].sort(compareText) : undefined
  } catch { return undefined }
}

/** Reads only bounded failed business members confirmed by this private binding. */
export function readResolvedRepairTaskIds(value: unknown): ReadonlySet<string> {
  try {
    const binding = record(value)
    if (!binding || !Object.hasOwn(binding, "resolvedRepairTaskIds")) return new Set()
    const { resolvedRepairTaskIds: ids, executionFailureOutcomes: _failureOutcomes, ...legacyBinding } = binding
    const facts = validateTaskGraphFollowUpBinding(legacyBinding), rows = dense(ids, TASK_GRAPH_LIMITS.maxPersistedNodes)
    if (!facts || !rows?.length) return new Set()
    const result = new Set<string>()
    let previous = ""
    for (const id of rows) {
      if (!safeTaskId(id) || id <= previous || facts.outcomes.get(id)?.taskStatus !== "failed") return new Set()
      result.add(id); previous = id
    }
    return result
  } catch { return new Set() }
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
function safeTaskId(value: unknown): value is string { return typeof value === "string" && SAFE_IDENTIFIER.test(value) }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

function dense(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null
  return Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ? value as Record<string, unknown> : null } catch { return null }
}
