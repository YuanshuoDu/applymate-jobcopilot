import { reduceTaskGraphFinalSummary, type TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import type { SubagentTaskStatus } from "./types.js"

export const TASK_GRAPH_FINAL_SUMMARY_BINDING: unique symbol = Symbol("task_graph_final_summary_binding")

export type TaskGraphFinalSummaryMember = Readonly<{
  nodeIndex: number
  nodeKey: string
  templateId: string
  taskId: string
  role: string
  taskType: string
  taskStatus: SubagentTaskStatus
  kind: "business" | "internal_control"
}>

export type TaskGraphFinalSummaryBinding = Readonly<{
  /** Required on bindings produced by this module; optional only for legacy internal carriers, which cannot emit a manifest. */
  rootTaskId?: string
  graphItemId?: string
  graphRevision: number
  members?: readonly TaskGraphFinalSummaryMember[]
  summary: TaskGraphFinalSummary
}>

/** Builds a private freshness binding from one already-loaded, owner-scoped current graph. */
export function buildTaskGraphFinalSummaryBinding(loaded: LoadedGraph): TaskGraphFinalSummaryBinding | null {
  if (!loaded.item) {
    if (loaded.snapshot || loaded.state || loaded.tasks.size > 0) throw new Error("task_graph_final_summary_graph_invalid")
    return null
  }
  if (!loaded.snapshot || !loaded.state || !nonEmpty(loaded.rootTaskId) || !nonEmpty(loaded.item.id)
    || !Array.isArray(loaded.snapshot.nodes) || loaded.snapshot.nodes.length > 8 || loaded.item.revision !== loaded.state.revision
    || !Number.isSafeInteger(loaded.item.revision) || loaded.item.revision < 1) {
    throw new Error("task_graph_final_summary_graph_invalid")
  }

  const seenTasks = new Set<string>()
  const members = loaded.snapshot.nodes.map((snapshotNode, nodeIndex): TaskGraphFinalSummaryMember => {
    const task = loaded.tasks.get(snapshotNode.taskId)
    if (!task || task.id !== snapshotNode.taskId || !nonEmpty(snapshotNode.key) || !nonEmpty(snapshotNode.templateId)
      || !nonEmpty(task.taskType) || !nonEmpty(task.role) || !TASK_STATUSES.has(task.status) || seenTasks.has(task.id)) {
      throw new Error("task_graph_final_summary_task_scope_invalid")
    }
    seenTasks.add(task.id)
    return { nodeIndex, nodeKey: snapshotNode.key, templateId: snapshotNode.templateId, taskId: task.id, role: task.role,
      taskType: task.taskType, taskStatus: task.status,
      kind: isNativeVerificationControl(task.role, task.taskType) ? "internal_control" : "business" }
  })
  const nodes = members.map(member => {
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
  return { rootTaskId: loaded.rootTaskId, graphItemId: loaded.item.id, graphRevision, members, summary }
}

/** Compares the exact current graph revision and all deterministic reducer facts. */
export function sameTaskGraphFinalSummaryBinding(
  left: TaskGraphFinalSummaryBinding | null | undefined,
  right: TaskGraphFinalSummaryBinding | null | undefined,
): boolean {
  try {
    if (!left || !right || left.rootTaskId !== right.rootTaskId || left.graphItemId !== right.graphItemId
      || JSON.stringify(left.members) !== JSON.stringify(right.members) || left.graphRevision !== right.graphRevision
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
