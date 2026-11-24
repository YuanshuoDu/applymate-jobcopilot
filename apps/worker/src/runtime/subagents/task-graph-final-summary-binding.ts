import { reduceTaskGraphFinalSummary, type TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { validateRoleResult } from "./role-results.js"
import type { SubagentTaskStatus } from "./types.js"
import { validateTaskGraphFollowUpBinding } from "./task-graph-follow-up-validation.js"
import { hasSelectedJobBatchMembers, readBoundSelectedJobBatchFinalOutcome, renderSelectedJobBatchFinalOutcome } from "./selected-job-batch-final-outcome.js"
import type { SelectedJobBatchFinalOutcome } from "./selected-job-batch-final-outcome.js"
import { hasObjectiveTailorFinalOutcome, readBoundObjectiveTailorFinalOutcome, renderObjectiveTailorFinalOutcome, type ObjectiveTailorFinalOutcomeProjection } from "./objective-tailor-final-summary-binding.js"
export { hasObjectiveTailorFinalOutcome, readBoundObjectiveTailorFinalOutcome, renderObjectiveTailorFinalOutcome, renderSelectedJobBatchFinalOutcome }

export const TASK_GRAPH_FINAL_SUMMARY_BINDING: unique symbol = Symbol("task_graph_final_summary_binding")

export type TaskGraphFinalSummaryMember = Readonly<{
  nodeIndex: number
  nodeKey: string
  templateId: string
  taskId: string
  role: string
  taskType: string
  taskStatus: SubagentTaskStatus
  kind: "business" | "internal_control" | "historical"
}>
type CurrentTaskGraphFinalSummaryMember = TaskGraphFinalSummaryMember & Readonly<{ kind: "business" | "internal_control" }>

export type TaskGraphFinalSummaryBinding = Readonly<{
  /** Required on bindings produced by this module; optional only for legacy internal carriers, which cannot emit a manifest. */
  rootTaskId?: string
  graphItemId?: string
  graphRevision: number
  members?: readonly TaskGraphFinalSummaryMember[]
  resolvedRepairTaskIds?: readonly string[]
  selectedJobBatchFinalOutcome?: SelectedJobBatchFinalOutcome
  objectiveTailorFinalOutcome?: ObjectiveTailorFinalOutcomeProjection
  summary: TaskGraphFinalSummary
}>

/** Builds a private freshness binding from one already-loaded, owner-scoped current graph. */
export function buildTaskGraphFinalSummaryBinding(
  loaded: LoadedGraph,
  historicalNodeIndices?: ReadonlySet<number>,
  resolvedRepairTaskIds?: ReadonlySet<string>,
): TaskGraphFinalSummaryBinding | null {
  const selectedHistory = selectedIndices(historicalNodeIndices)
  if (!loaded.item) {
    if (selectedHistory.length > 0) throw new Error("task_graph_final_summary_historical_selection_invalid")
    if (loaded.snapshot || loaded.state || loaded.tasks.size > 0) throw new Error("task_graph_final_summary_graph_invalid")
    return null
  }
  if (!loaded.snapshot || !loaded.state || !nonEmpty(loaded.rootTaskId) || !nonEmpty(loaded.item.id)
    || !Array.isArray(loaded.snapshot.nodes) || loaded.snapshot.nodes.length > TASK_GRAPH_LIMITS.maxPersistedNodes || loaded.item.revision !== loaded.state.revision
    || !Number.isSafeInteger(loaded.item.revision) || loaded.item.revision < 1) {
    throw new Error("task_graph_final_summary_graph_invalid")
  }

  const seenTasks = new Set<string>()
  const members = loaded.snapshot.nodes.map((snapshotNode, nodeIndex): TaskGraphFinalSummaryMember => {
    const task = loaded.tasks.get(snapshotNode.taskId)
    if (!task || task.id !== snapshotNode.taskId || !nonEmpty(snapshotNode.key) || !nonEmpty(snapshotNode.templateId)
      || !nonEmpty(task.taskType) || !nonEmpty(task.role) || !TASK_STATUSES.has(task.status)) {
      throw new Error("task_graph_final_summary_task_scope_invalid")
    }
    if (seenTasks.has(task.id)) throw new Error("task_graph_final_summary_task_identity_conflict")
    seenTasks.add(task.id)
    return { nodeIndex, nodeKey: snapshotNode.key, templateId: snapshotNode.templateId, taskId: task.id, role: task.role,
      taskType: task.taskType, taskStatus: task.status,
      kind: isNativeVerificationControl(task.role, task.taskType) ? "internal_control" : "business" }
  })
  for (const nodeIndex of selectedHistory) {
    const member = members[nodeIndex]
    const task = member && loaded.tasks.get(member.taskId)
    if (!member || !task || !isHistoricalScoutAnalyst(member, task)) {
      throw new Error("task_graph_final_summary_historical_selection_invalid")
    }
  }
  const boundMembers = members.map(member => selectedHistory.includes(member.nodeIndex) ? { ...member, kind: "historical" as const } : member)
  if (selectedHistory.length > 0 && !boundMembers.some(member => member.kind === "business")) {
    throw new Error("task_graph_final_summary_historical_selection_invalid")
  }
  const nodes = boundMembers.filter((member): member is CurrentTaskGraphFinalSummaryMember => member.kind !== "historical").map(member => {
    const task = loaded.tasks.get(member.taskId)!
    const nested = persistedStructuredResult(task.result)
    return {
      kind: member.kind,
      taskId: member.taskId,
      role: member.role,
      taskStatus: member.taskStatus,
      ...(Number.isSafeInteger(task.attemptCount) && task.attemptCount! > 0 ? { attemptCount: task.attemptCount } : {}),
      ...(nested.present ? { structuredResult: nested.value } : {}),
    }
  })
  const graphRevision = loaded.item.revision
  const summary = reduceTaskGraphFinalSummary({ graphRevision, nodes })
  const resolved = normalizeResolvedRepairTaskIds(resolvedRepairTaskIds, boundMembers, summary)
  return { rootTaskId: loaded.rootTaskId, graphItemId: loaded.item.id, graphRevision, members: boundMembers,
    ...(resolved ? { resolvedRepairTaskIds: resolved } : {}), summary }
}

/** Reads only bounded failed business members confirmed by this private binding. */
export function readResolvedRepairTaskIds(value: unknown): ReadonlySet<string> {
  try {
    const binding = record(value)
    if (!binding || !Object.hasOwn(binding, "resolvedRepairTaskIds")) return new Set()
    const ids = binding.resolvedRepairTaskIds, legacyBinding = { ...binding }
    if (hasObjectiveTailorFinalOutcome(binding) && !readBoundObjectiveTailorFinalOutcome(binding)) return new Set()
    Reflect.deleteProperty(legacyBinding, "objectiveTailorFinalOutcome"); Reflect.deleteProperty(legacyBinding, "resolvedRepairTaskIds")
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

/** Compares the exact current graph revision and all deterministic reducer facts. */
export function sameTaskGraphFinalSummaryBinding(
  left: TaskGraphFinalSummaryBinding | null | undefined,
  right: TaskGraphFinalSummaryBinding | null | undefined,
): boolean {
  try {
    if (!left || !right) return false
    const leftHasBatch = hasSelectedJobBatchMembers(left), rightHasBatch = hasSelectedJobBatchMembers(right)
    const leftHasTailor = hasObjectiveTailorFinalOutcome(left), rightHasTailor = hasObjectiveTailorFinalOutcome(right)
    if (leftHasBatch !== rightHasBatch || leftHasTailor !== rightHasTailor) return false
    const leftTailor = readBoundObjectiveTailorFinalOutcome(left), rightTailor = readBoundObjectiveTailorFinalOutcome(right)
    if (leftHasTailor && (!leftTailor || !rightTailor)) return false
    const leftBatch = left.selectedJobBatchFinalOutcome, rightBatch = right.selectedJobBatchFinalOutcome
    if (leftHasBatch) {
      if (!readBoundSelectedJobBatchFinalOutcome(left) || !readBoundSelectedJobBatchFinalOutcome(right)) return false
    } else if (leftBatch !== undefined || rightBatch !== undefined) return false
    if (left.rootTaskId !== right.rootTaskId || left.graphItemId !== right.graphItemId
      || JSON.stringify(left.members) !== JSON.stringify(right.members) || left.graphRevision !== right.graphRevision
      || JSON.stringify(left.resolvedRepairTaskIds) !== JSON.stringify(right.resolvedRepairTaskIds)
      || JSON.stringify(leftBatch) !== JSON.stringify(rightBatch) || JSON.stringify(leftTailor) !== JSON.stringify(rightTailor)
      || left.summary.graphRevision !== left.graphRevision || right.summary.graphRevision !== right.graphRevision) return false
    return JSON.stringify(left.summary) === JSON.stringify(right.summary)
  }
  catch { return false }
}

const TASK_STATUSES = new Set<SubagentTaskStatus>(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }

function normalizeResolvedRepairTaskIds(value: ReadonlySet<string> | undefined, members: readonly TaskGraphFinalSummaryMember[], summary: TaskGraphFinalSummary): readonly string[] | undefined {
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

function dense(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null
  return Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ? value as Record<string, unknown> : null } catch { return null }
}

function safeTaskId(value: unknown): value is string { return typeof value === "string" && SAFE_IDENTIFIER.test(value) }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function isNativeVerificationControl(role: string, taskType: string): boolean {
  return role === "auditor" && taskType === "native_verification"
}

function persistedStructuredResult(value: unknown): Readonly<{ present: boolean; value?: unknown }> {
  const envelope = jsonRecord(value)
  if (!envelope || !Object.hasOwn(envelope, "structuredResult")) return { present: false }
  return { present: true, value: envelope.structuredResult }
}

function selectedIndices(value?: ReadonlySet<number>): number[] {
  if (value === undefined) return []
  try {
    if (!value || typeof value[Symbol.iterator] !== "function") throw new Error()
    const indices: number[] = [], seen = new Set<number>()
    for (const index of value) {
      if (indices.length >= TASK_GRAPH_LIMITS.maxPersistedNodes || !Number.isSafeInteger(index) || index < 0 || seen.has(index)) throw new Error()
      indices.push(index)
      seen.add(index)
    }
    return indices
  } catch { throw new Error("task_graph_final_summary_historical_selection_invalid") }
}

function isHistoricalScoutAnalyst(member: TaskGraphFinalSummaryMember, task: GraphTaskRow): boolean {
  if ((member.role !== "scout" && member.role !== "analyst") || member.templateId !== member.role || member.taskStatus !== "completed"
    || task.role !== member.role || task.status !== member.taskStatus) return false
  const nested = persistedStructuredResult(task.result)
  if (!nested.present) return false
  try { validateRoleResult(nested.value, member.role); return true } catch { return false }
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown }
    catch { return null }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(parsed).length === 0
      ? parsed as Record<string, unknown> : null
  } catch { return null }
}
