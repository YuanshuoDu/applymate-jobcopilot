import { reduceTaskGraphFinalSummary, type TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { validateRoleResult } from "./role-results.js"
import type { SubagentTaskStatus } from "./types.js"
import { normalizeResolvedRepairTaskIds } from "./task-graph-final-summary-repair-binding.js"
export { readResolvedRepairTaskIds } from "./task-graph-final-summary-repair-binding.js"
import { hasSelectedJobBatchMembers, readBoundSelectedJobBatchFinalOutcome } from "./selected-job-batch-final-outcome.js"
import type { SelectedJobBatchFinalOutcome } from "./selected-job-batch-final-outcome.js"
import { parseSponsorshipFinalAnswerBinding, sameSponsorshipFinalAnswerBinding, type SponsorshipFinalAnswerBinding } from "./sponsorship-final-answer-contract.js"

export const TASK_GRAPH_FINAL_SUMMARY_BINDING: unique symbol = Symbol("task_graph_final_summary_binding")

type TaskGraphFinalSummaryMemberBase = Readonly<{
  nodeIndex: number
  nodeKey: string
  templateId: string
  taskId: string
  role: string
  taskType: string
  taskStatus: SubagentTaskStatus
}>
export type TaskGraphRetiredScoutProof = Readonly<{
  nodeKey: string
  taskId: string
  attempt: number
  interruptRequestedAt: string
  receiptEventId: string
  lifecycleEventId: string
}>
export type TaskGraphFinalSummaryMember = TaskGraphFinalSummaryMemberBase & (
  | Readonly<{ kind: "business" | "internal_control" | "historical" }>
  | Readonly<{ kind: "retired"; retirement: Omit<TaskGraphRetiredScoutProof, "nodeKey" | "taskId"> }>
)
type CurrentTaskGraphFinalSummaryMember = TaskGraphFinalSummaryMemberBase & Readonly<{ kind: "business" | "internal_control" }>

export type TaskGraphFinalSummaryBinding = Readonly<{
  /** Required on bindings produced by this module; optional only for legacy internal carriers, which cannot emit a manifest. */
  rootTaskId?: string
  graphItemId?: string
  graphRevision: number
  members?: readonly TaskGraphFinalSummaryMember[]
  resolvedRepairTaskIds?: readonly string[]
  selectedJobBatchFinalOutcome?: SelectedJobBatchFinalOutcome
  /** Private server-built listing assessment, re-read under the terminal fence. */
  sponsorshipFinalAnswer?: SponsorshipFinalAnswerBinding
  summary: TaskGraphFinalSummary
}>

/** Builds a private freshness binding from one already-loaded, owner-scoped current graph. */
export function buildTaskGraphFinalSummaryBinding(
  loaded: LoadedGraph,
  historicalNodeIndices?: ReadonlySet<number>,
  resolvedRepairTaskIdsOrRetiredScouts?: ReadonlySet<string> | ReadonlyMap<string, TaskGraphRetiredScoutProof>,
  retiredScouts?: ReadonlyMap<string, TaskGraphRetiredScoutProof>,
): TaskGraphFinalSummaryBinding | null {
  const thirdArgumentIsRetirementMap = isRetiredScoutMap(resolvedRepairTaskIdsOrRetiredScouts)
  const resolvedRepairTaskIds = thirdArgumentIsRetirementMap ? undefined : resolvedRepairTaskIdsOrRetiredScouts as ReadonlySet<string> | undefined
  const retirementSelection = thirdArgumentIsRetirementMap ? resolvedRepairTaskIdsOrRetiredScouts : retiredScouts
  const selectedHistory = selectedIndices(historicalNodeIndices)
  const selectedRetirements = selectedRetiredScouts(retirementSelection)
  if (!loaded.item) {
    if (selectedHistory.length > 0) throw new Error("task_graph_final_summary_historical_selection_invalid")
    if (selectedRetirements.length > 0) throw new Error("task_graph_final_summary_retired_selection_invalid")
    if (loaded.snapshot || loaded.state || loaded.tasks.size > 0) throw new Error("task_graph_final_summary_graph_invalid")
    return null
  }
  if (!loaded.snapshot || !loaded.state || !nonEmpty(loaded.rootTaskId) || !nonEmpty(loaded.item.id)
    || !Array.isArray(loaded.snapshot.nodes) || loaded.snapshot.nodes.length > TASK_GRAPH_LIMITS.maxPersistedNodes || loaded.item.revision !== loaded.state.revision
    || !Number.isSafeInteger(loaded.item.revision) || loaded.item.revision < 1) {
    throw new Error("task_graph_final_summary_graph_invalid")
  }
  if (selectedRetirements.some(proof => !loaded.snapshot!.nodes.some(node => node.key === proof.nodeKey))) {
    throw new Error("task_graph_final_summary_retired_selection_invalid")
  }

  const seenTasks = new Set<string>()
  const memberByKey = new Map(selectedRetirements.map(proof => [proof.nodeKey, proof] as const))
  const members = loaded.snapshot.nodes.map((snapshotNode, nodeIndex): TaskGraphFinalSummaryMember => {
    const task = loaded.tasks.get(snapshotNode.taskId)
    if (!task || task.id !== snapshotNode.taskId || !nonEmpty(snapshotNode.key) || !nonEmpty(snapshotNode.templateId)
      || !nonEmpty(task.taskType) || !nonEmpty(task.role) || !TASK_STATUSES.has(task.status)) {
      throw new Error("task_graph_final_summary_task_scope_invalid")
    }
    if (seenTasks.has(task.id)) throw new Error("task_graph_final_summary_task_identity_conflict")
    seenTasks.add(task.id)
    const member: CurrentTaskGraphFinalSummaryMember = { nodeIndex, nodeKey: snapshotNode.key, templateId: snapshotNode.templateId, taskId: task.id, role: task.role,
      taskType: task.taskType, taskStatus: task.status,
      kind: isNativeVerificationControl(task.role, task.taskType) ? "internal_control" : "business" }
    const proof = memberByKey.get(snapshotNode.key)
    if (!proof) return member
    if (!validRetiredScout(proof, snapshotNode, task)) throw new Error("task_graph_final_summary_retired_selection_invalid")
    return { ...member, kind: "retired", retirement: {
      attempt: proof.attempt, interruptRequestedAt: proof.interruptRequestedAt,
      receiptEventId: proof.receiptEventId, lifecycleEventId: proof.lifecycleEventId,
    } }
  })
  for (const nodeIndex of selectedHistory) {
    const member = members[nodeIndex]
    const task = member && loaded.tasks.get(member.taskId)
    if (!member || !task || !isHistoricalScoutAnalyst(member, task)) {
      throw new Error("task_graph_final_summary_historical_selection_invalid")
    }
  }
  if (selectedRetirements.some(proof => selectedHistory.includes(members.find(member => member.nodeKey === proof.nodeKey)?.nodeIndex ?? -1))) {
    throw new Error("task_graph_final_summary_retired_selection_invalid")
  }
  const boundMembers = members.map(member => selectedHistory.includes(member.nodeIndex) ? { ...member, kind: "historical" as const } : member)
  if (selectedHistory.length > 0 && !boundMembers.some(member => member.kind === "business")) {
    throw new Error("task_graph_final_summary_historical_selection_invalid")
  }
  const nodes = boundMembers.filter((member): member is CurrentTaskGraphFinalSummaryMember => member.kind === "business" || member.kind === "internal_control").map(member => {
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

/** Attaches a private, closed current-source projection to an otherwise valid objective summary. */
export function bindSponsorshipFinalAnswer(binding: TaskGraphFinalSummaryBinding | null | undefined,
  value: unknown): TaskGraphFinalSummaryBinding | null {
  const sponsorshipFinalAnswer = parseSponsorshipFinalAnswerBinding(value)
  if (!binding || !sponsorshipFinalAnswer || binding.rootTaskId !== sponsorshipFinalAnswer.rootTaskId) return null
  return { ...binding, sponsorshipFinalAnswer }
}

/** Compares the exact current graph revision and all deterministic reducer facts. */
export function sameTaskGraphFinalSummaryBinding(
  left: TaskGraphFinalSummaryBinding | null | undefined,
  right: TaskGraphFinalSummaryBinding | null | undefined,
): boolean {
  try {
    if (!left || !right) return false
    const leftHasBatch = hasSelectedJobBatchMembers(left), rightHasBatch = hasSelectedJobBatchMembers(right)
    if (leftHasBatch !== rightHasBatch) return false
    const leftBatch = left.selectedJobBatchFinalOutcome, rightBatch = right.selectedJobBatchFinalOutcome
    if (leftHasBatch) {
      if (!readBoundSelectedJobBatchFinalOutcome(left) || !readBoundSelectedJobBatchFinalOutcome(right)) return false
    } else if (leftBatch !== undefined || rightBatch !== undefined) return false
    const leftSponsorship = left.sponsorshipFinalAnswer, rightSponsorship = right.sponsorshipFinalAnswer
    if (leftSponsorship !== undefined || rightSponsorship !== undefined) {
      if (!leftSponsorship || !rightSponsorship || !sameSponsorshipFinalAnswerBinding(leftSponsorship, rightSponsorship)) return false
    }
    if (left.rootTaskId !== right.rootTaskId || left.graphItemId !== right.graphItemId
      || JSON.stringify(left.members) !== JSON.stringify(right.members) || left.graphRevision !== right.graphRevision
      || JSON.stringify(left.resolvedRepairTaskIds) !== JSON.stringify(right.resolvedRepairTaskIds)
      || JSON.stringify(leftBatch) !== JSON.stringify(rightBatch)
      || left.summary.graphRevision !== left.graphRevision || right.summary.graphRevision !== right.graphRevision) return false
    return JSON.stringify(left.summary) === JSON.stringify(right.summary)
  }
  catch { return false }
}

const TASK_STATUSES = new Set<SubagentTaskStatus>(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
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

function selectedRetiredScouts(value?: ReadonlyMap<string, TaskGraphRetiredScoutProof>): TaskGraphRetiredScoutProof[] {
  if (value === undefined) return []
  try {
    if (!value || typeof value[Symbol.iterator] !== "function") throw new Error()
    const result: TaskGraphRetiredScoutProof[] = [], seen = new Set<string>()
    for (const [key, proof] of value) {
      if (result.length >= TASK_GRAPH_LIMITS.maxPersistedNodes || !proof || key !== proof.nodeKey || seen.has(key)
        || Object.keys(proof).sort().join(",") !== "attempt,interruptRequestedAt,lifecycleEventId,nodeKey,receiptEventId,taskId"
        || !nonEmpty(key) || !nonEmpty(proof.taskId) || !nonEmpty(proof.receiptEventId) || !nonEmpty(proof.lifecycleEventId)
        || !Number.isSafeInteger(proof.attempt) || proof.attempt < 1 || !canonicalTimestamp(proof.interruptRequestedAt)) throw new Error()
      seen.add(key)
      result.push(proof)
    }
    return result
  } catch { throw new Error("task_graph_final_summary_retired_selection_invalid") }
}

function isRetiredScoutMap(value: unknown): value is ReadonlyMap<string, TaskGraphRetiredScoutProof> {
  return Boolean(value && typeof value === "object" && typeof (value as ReadonlyMap<string, TaskGraphRetiredScoutProof>).get === "function")
}

function validRetiredScout(proof: TaskGraphRetiredScoutProof, node: Pick<StoredTaskGraphNode, "key" | "templateId">, task: GraphTaskRow): boolean {
  return node.templateId === "scout" && proof.nodeKey === node.key && proof.taskId === task.id && task.role === "scout"
    && task.taskType === "job_discovery" && task.status === "interrupted"
    && task.attemptCount === proof.attempt
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false
  try { return new Date(value).toISOString() === value } catch { return false }
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
