import type pg from "pg"
import { projectSelectedJobMemory, type SelectedJobMemoryRecord } from "./selected-job-memory.js"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"

type Queryable = Pick<pg.PoolClient, "query">

function isDatabaseError(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("code" in value)) return false
  return typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code)
}

function isTaskGraphDomainError(value: unknown): boolean {
  return value instanceof Error && !isDatabaseError(value)
    && /^task_graph_[a-z0-9_]+$/.test(value.message)
}

/** Rebuilds a source memory only after its owning terminal Turn was verified by the store. */
export async function revalidateSelectedJobHistoryGraph(
  client: Queryable,
  scope: GraphIdentityScope,
  candidate: SelectedJobMemoryRecord,
): Promise<SelectedJobMemoryRecord | undefined> {
  try {
    const loaded = await loadTaskGraph(client, scope, false)
    const graph = currentTaskGraph(loaded)
    return projectSelectedJobMemory({
      jobId: candidate.jobId,
      sourceTurnId: scope.turnId,
      sourceRootTaskId: scope.rootTaskId,
      throughSequence: candidate.throughSequence,
      graph,
    }) ?? undefined
  } catch (error: unknown) {
    if (isTaskGraphDomainError(error)) return undefined
    throw error
  }
}
