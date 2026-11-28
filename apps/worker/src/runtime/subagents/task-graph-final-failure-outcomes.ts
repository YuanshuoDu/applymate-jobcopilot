import { isSelectedJobBatchTemplateId } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./task-graph-child-deadline.js"
import { currentTaskGraph, type LoadedGraph } from "./task-graph-pg-state.js"
import { validateTaskGraphFollowUpBinding } from "./task-graph-follow-up-validation.js"
import { classifyCurrentTaskGraphExecutionFailure, type TaskGraphExecutionFailureCategory } from "./task-graph-failure-category.js"
import type { TaskGraphCurrentNode, TaskGraphCurrentState } from "./task-graph-command-port.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"

type Member = Readonly<{ taskId: string; nodeKey: string; templateId: string; role: string; taskStatus: string; kind: string }>
type FailureOutcome = Readonly<{ taskId: string; category: TaskGraphExecutionFailureCategory }>
type SummaryOutcome = TaskGraphFinalSummary["taskOutcomes"][number]
const CATEGORIES = new Set<TaskGraphExecutionFailureCategory>([
  "execution_setup_unavailable", "resume_state_unavailable", "structured_output_invalid", "execution_deadline_exceeded",
])
const EXTENSION_KEYS = new Set(["executionFailureOutcomes", "resolvedRepairTaskIds", "selectedJobBatchFinalOutcome"])
const BINDING_KEYS = new Set(["graphItemId", "graphRevision", "members", "rootTaskId", "summary", ...EXTENSION_KEYS])

/** Builds closed failure cues only from the owner-loaded graph and its failed business projection. */
export function buildFinalExecutionFailureOutcomes(
  loaded: LoadedGraph,
  members: readonly Member[],
  summary: TaskGraphFinalSummary,
): readonly FailureOutcome[] | undefined {
  try {
    if (members.some(member => isSelectedJobBatchTemplateId(member.templateId))) return undefined
    const current = currentTaskGraph(loaded)
    return projectCurrentFailures(current, members, summary)
  } catch { return undefined }
}

/** Reads only categories rebound to failed business outcomes in the exact private core binding. */
export function readFinalExecutionFailureOutcomes(value: unknown): ReadonlyMap<string, TaskGraphExecutionFailureCategory> {
  try {
    const binding = dataRecord(value)
    if (!binding || Object.keys(binding).some(key => !BINDING_KEYS.has(key))
      || Object.hasOwn(binding, "selectedJobBatchFinalOutcome") || hasBatchMembers(binding.members)) return new Map()
    if (!Object.hasOwn(binding, "executionFailureOutcomes")) return new Map()
    const facts = validateTaskGraphFollowUpBinding(coreBinding(binding))
    const rows = dense(binding.executionFailureOutcomes, TASK_GRAPH_LIMITS.maxPersistedNodes)
    if (!facts || !rows?.length) return new Map()
    const result = new Map<string, TaskGraphExecutionFailureCategory>()
    let previous = ""
    for (const value of rows) {
      const row = dataRecord(value)
      if (!row || !exactKeys(row, "category,taskId") || !safeTaskId(row.taskId) || !CATEGORIES.has(row.category as TaskGraphExecutionFailureCategory)
        || row.taskId <= previous || facts.outcomes.get(row.taskId)?.taskStatus !== "failed") return new Map()
      result.set(row.taskId, row.category as TaskGraphExecutionFailureCategory)
      previous = row.taskId
    }
    return result
  } catch { return new Map() }
}

function projectCurrentFailures(
  current: TaskGraphCurrentState,
  members: readonly Member[],
  summary: TaskGraphFinalSummary,
): readonly FailureOutcome[] | undefined {
  if (current.revision !== summary.graphRevision || current.nodes.length > TASK_GRAPH_LIMITS.maxPersistedNodes
    || members.length > TASK_GRAPH_LIMITS.maxPersistedNodes) return undefined
  const currentByTask = new Map<string, TaskGraphCurrentNode>()
  for (const node of current.nodes) {
    if (currentByTask.has(node.taskId)) return undefined
    currentByTask.set(node.taskId, node)
  }
  const outcomes = new Map<string, SummaryOutcome>()
  for (const outcome of summary.taskOutcomes) {
    if (outcomes.has(outcome.taskId)) return undefined
    outcomes.set(outcome.taskId, outcome)
  }
  const rows: FailureOutcome[] = []
  for (const member of members) {
    if (member.kind !== "business" || member.taskStatus !== "failed") continue
    const outcome = outcomes.get(member.taskId), node = currentByTask.get(member.taskId)
    if (!outcome || outcome.taskStatus !== "failed" || !node || node.status !== "failed"
      || outcome.role !== summaryRole(member.role) || node.key !== member.nodeKey || node.templateId !== member.templateId) continue
    const category = currentFailureCategory(node)
    if (category) rows.push({ taskId: member.taskId, category })
  }
  rows.sort((left, right) => compareText(left.taskId, right.taskId))
  return rows.length ? rows : undefined
}

function currentFailureCategory(node: TaskGraphCurrentNode): TaskGraphExecutionFailureCategory | undefined {
  const report = node.verificationReport, contract = node.verification, ids = node.verificationCriterionIds
  const isNative = !!node.native || !!node.nativeResult
  const candidate = classifyCurrentTaskGraphExecutionFailure(node, { hasVerifiedReport: false, isNative })
  if (!candidate || !report) return candidate
  const isUnverifiedResume = candidate === "resume_state_unavailable" && !!contract && report.status === "unverified"
    && report.reasonCode === "result_invalid" && report.evidenceDigest === null && report.resultDigest === null
    && !!ids && report.criteria.length === ids.length
    && report.criteria.every((item, index) => item.criterionId === ids[index] && item.status === "unverified" && item.reasonCode === "result_invalid")
    && (node.templateId === "scout" && contract.role === "scout" || node.templateId === "analyst" && contract.role === "analyst")
  const isUnverifiedDeadline = candidate === "execution_deadline_exceeded"
    && node.failureReason === TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON && report.status === "unverified"
  const hasVerifiedReport = !isUnverifiedResume && !isUnverifiedDeadline
  return classifyCurrentTaskGraphExecutionFailure(node, { hasVerifiedReport, isNative })
}

function coreBinding(binding: Record<string, unknown>): Record<string, unknown> {
  const core: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of ["graphItemId", "graphRevision", "members", "rootTaskId", "summary"]) {
    if (Object.hasOwn(binding, key)) core[key] = binding[key]
  }
  return core
}

function hasBatchMembers(value: unknown): boolean {
  const rows = dense(value, TASK_GRAPH_LIMITS.maxPersistedNodes)
  if (!rows) return false
  return rows.some(value => {
    const member = dataRecord(value)
    return !!member && typeof member.templateId === "string" && isSelectedJobBatchTemplateId(member.templateId)
  })
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length > BINDING_KEYS.size) return null
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      if (typeof key !== "string") return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      copy[key] = descriptor.value
    }
    return copy
  } catch { return null }
}

function dense(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) return null
    const rows: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      rows.push(descriptor.value)
    }
    return rows
  } catch { return null }
}

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected
}
function safeTaskId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) }
function summaryRole(value: string): SummaryOutcome["role"] {
  return ["analyst", "prepare", "reviewer", "scout", "writer"].includes(value) ? value as SummaryOutcome["role"] : "unsupported"
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
