import { reduceTaskGraphFinalSummary, type TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"

export const TASK_GRAPH_FINAL_SUMMARY_BINDING: unique symbol = Symbol("task_graph_final_summary_binding")

export type TaskGraphFinalSummaryBinding = Readonly<{
  graphRevision: number
  summary: TaskGraphFinalSummary
}>

/** Builds a private freshness binding from one already-loaded, owner-scoped current graph. */
export function buildTaskGraphFinalSummaryBinding(loaded: LoadedGraph): TaskGraphFinalSummaryBinding | null {
  if (!loaded.item) {
    if (loaded.snapshot || loaded.state || loaded.tasks.size > 0) throw new Error("task_graph_final_summary_graph_invalid")
    return null
  }
  if (!loaded.snapshot || !loaded.state || loaded.item.revision !== loaded.state.revision
    || !Number.isSafeInteger(loaded.item.revision) || loaded.item.revision < 1) {
    throw new Error("task_graph_final_summary_graph_invalid")
  }

  const nodes = loaded.snapshot.nodes.map(snapshotNode => {
    const task = loaded.tasks.get(snapshotNode.taskId)
    if (!task || task.id !== snapshotNode.taskId || typeof task.taskType !== "string") {
      throw new Error("task_graph_final_summary_task_scope_invalid")
    }
    const nested = persistedStructuredResult(task.result)
    return {
      kind: isNativeVerificationControl(task.role, task.taskType) ? "internal_control" as const : "business" as const,
      taskId: task.id,
      role: task.role,
      taskStatus: task.status,
      ...(nested.present ? { structuredResult: nested.value } : {}),
    }
  })
  const graphRevision = loaded.item.revision
  const summary = reduceTaskGraphFinalSummary({ graphRevision, nodes })
  return { graphRevision, summary }
}

/** Compares the exact current graph revision and all deterministic reducer facts. */
export function sameTaskGraphFinalSummaryBinding(
  left: TaskGraphFinalSummaryBinding | null | undefined,
  right: TaskGraphFinalSummaryBinding | null | undefined,
): boolean {
  try {
    if (!left || !right || left.graphRevision !== right.graphRevision
      || left.summary.graphRevision !== left.graphRevision || right.summary.graphRevision !== right.graphRevision) return false
    return JSON.stringify(left.summary) === JSON.stringify(right.summary)
  }
  catch { return false }
}

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
