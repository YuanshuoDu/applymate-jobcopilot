import type { SteeringReconciliationState } from "../subagents/steering-reconciliation-contract.js"
import type { GraphTaskRow, LoadedGraph } from "../subagents/task-graph-pg-state.js"
import type { StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"

type LatestUserRevision = NonNullable<SteeringReconciliationState["latestUserRevision"]>
export type TaskGraphCompletionApplicability = Readonly<{
  kind: "applicable"; historicalNodeIndices: ReadonlySet<number>
}> | Readonly<{ kind: "replan" }>

/** Excludes only verified old read-only Scout/Analyst results after an owned user revision. */
export function taskGraphCompletionApplicability(
  loaded: LoadedGraph,
  latestUserRevision: LatestUserRevision | undefined,
  currentRevision: number,
  verifiedCompletedTaskIds: ReadonlySet<string>,
  compatibleRetainedScoutKeys: ReadonlySet<string> = new Set(),
): TaskGraphCompletionApplicability {
  if (!latestUserRevision) return { kind: "applicable", historicalNodeIndices: new Set() }
  if (!loaded.snapshot || !loaded.item || loaded.item.revision !== currentRevision
    || latestUserRevision.resultingRevision > currentRevision || latestUserRevision.inputThroughSequence < 0n
    || !loaded.sourceInputCheckpointByNodeKey) return { kind: "replan" }

  const historicalNodeIndices = new Set<number>(), historicalKeys = new Set<string>(), currentRoles = new Set<string>()
  for (const [nodeIndex, node] of loaded.snapshot.nodes.entries()) {
    const task = loaded.tasks.get(node.taskId), role = exactRole(node, task)
    if (!role) continue
    const source = loaded.sourceInputCheckpointByNodeKey.get(node.key)
    if (!source) return { kind: "replan" }
    if (source.inputThroughSequence < latestUserRevision.inputThroughSequence) {
      if (role === "scout" && compatibleRetainedScoutKeys.has(node.key) && task?.status === "completed"
        && task.failureReason === null && verifiedCompletedTaskIds.has(task.id)) {
        currentRoles.add(role)
        continue
      }
      if (task?.status === "completed" && task.failureReason === null && verifiedCompletedTaskIds.has(task.id)) {
        historicalNodeIndices.add(nodeIndex)
        historicalKeys.add(node.key)
      } else return { kind: "replan" }
      continue
    }
    if (task?.status === "completed" && task.failureReason === null && verifiedCompletedTaskIds.has(task.id)) currentRoles.add(role)
  }

  for (const nodeIndex of historicalNodeIndices) {
    const node = loaded.snapshot.nodes[nodeIndex]!
    const role = node.templateId
    if (!currentRoles.has(role)) return { kind: "replan" }
  }
  for (const [nodeIndex, node] of loaded.snapshot.nodes.entries()) {
    if (historicalNodeIndices.has(nodeIndex)) continue
    if (node.dependsOn.some(key => historicalKeys.has(key)) || node.repairOf && historicalKeys.has(node.repairOf.nodeKey)) {
      return { kind: "replan" }
    }
  }
  return { kind: "applicable", historicalNodeIndices }
}

function exactRole(node: StoredTaskGraphNode, task: GraphTaskRow | undefined): string | null {
  const role = node.templateId
  const taskType = role === "scout" ? "job_discovery" : role === "analyst" ? "job_analysis" : null
  return taskType !== null && task?.role === role && task.taskType === taskType ? role : null
}
