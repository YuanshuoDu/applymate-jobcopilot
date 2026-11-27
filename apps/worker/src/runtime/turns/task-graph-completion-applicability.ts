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
  retiredScoutKeys: ReadonlySet<string> = new Set(),
): TaskGraphCompletionApplicability {
  if (!latestUserRevision) return retiredScoutKeys instanceof Set && retiredScoutKeys.size === 0
    ? { kind: "applicable", historicalNodeIndices: new Set() } : { kind: "replan" }
  if (!loaded.snapshot || !loaded.item || loaded.item.revision !== currentRevision
    || latestUserRevision.resultingRevision > currentRevision || latestUserRevision.inputThroughSequence < 0n
    || !loaded.sourceInputCheckpointByNodeKey || !validRetiredScouts(loaded, retiredScoutKeys, latestUserRevision)) return { kind: "replan" }

  const historicalNodeIndices = new Set<number>(), historicalKeys = new Set<string>(), currentRoles = new Set<string>()
  for (const [nodeIndex, node] of loaded.snapshot.nodes.entries()) {
    if (retiredScoutKeys.has(node.key)) continue
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
    if (historicalNodeIndices.has(nodeIndex) || retiredScoutKeys.has(node.key)) continue
    if (node.dependsOn.some(key => historicalKeys.has(key) || retiredScoutKeys.has(key))
      || node.repairOf && (historicalKeys.has(node.repairOf.nodeKey) || retiredScoutKeys.has(node.repairOf.nodeKey))) {
      return { kind: "replan" }
    }
  }
  return { kind: "applicable", historicalNodeIndices }
}

function validRetiredScouts(loaded: LoadedGraph, keys: ReadonlySet<string>, revision: LatestUserRevision): boolean {
  if (!(keys instanceof Set) || keys.size > loaded.snapshot!.nodes.length) return false
  for (const key of keys) {
    const node = loaded.snapshot!.nodes.find(candidate => candidate.key === key), task = node && loaded.tasks.get(node.taskId)
    const source = loaded.sourceInputCheckpointByNodeKey?.get(key)
    if (!node || !task || node.templateId !== "scout" || node.verificationDisposition !== "typed"
      || node.verification?.role !== "scout" || node.nativeDelegation || node.repairOf || node.dependsOn.length
      || task.role !== "scout" || task.taskType !== "job_discovery" || task.status !== "interrupted"
      || !Number.isSafeInteger(task.attemptCount) || task.attemptCount! < 1
      || !source || typeof source.inputThroughSequence !== "bigint"
      || source.inputThroughSequence >= revision.inputThroughSequence) return false
  }
  return true
}

function exactRole(node: StoredTaskGraphNode, task: GraphTaskRow | undefined): string | null {
  const role = node.templateId
  const taskType = role === "scout" ? "job_discovery" : role === "analyst" ? "job_analysis" : null
  return taskType !== null && task?.role === role && task.taskType === taskType ? role : null
}
