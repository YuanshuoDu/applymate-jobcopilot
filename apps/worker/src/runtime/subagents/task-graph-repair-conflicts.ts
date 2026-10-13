import type { TaskGraphNode, TaskGraphNodeProposal, TaskGraphRepairOf } from "../planning/task-graph.js"
import { isTerminalSubagentStatus } from "./types.js"

function sameRepairTarget(left: TaskGraphRepairOf, right: TaskGraphRepairOf): boolean {
  return left.graphRootTaskId === right.graphRootTaskId
    && left.nodeKey === right.nodeKey
    && left.taskId === right.taskId
}

function overlaps(left: TaskGraphRepairOf, right: TaskGraphRepairOf): boolean {
  if (!sameRepairTarget(left, right)) return false
  const rightCriteria = new Set(right.criterionIds)
  return left.criterionIds.some(id => rightCriteria.has(id))
}

/** True when a proposed repair overlaps an in-flight repair for the same exact target. */
export function hasOverlappingTaskGraphRepair(
  currentNodes: readonly TaskGraphNode[],
  appendedNodes: readonly TaskGraphNodeProposal[],
): boolean {
  const activeRepairs = currentNodes.filter(node => node.repairOf && !isTerminalSubagentStatus(node.status))
  const proposedRepairs = appendedNodes.flatMap(node => node.repairOf ? [node.repairOf] : [])
  for (let index = 0; index < proposedRepairs.length; index++) {
    const candidate = proposedRepairs[index]!
    if (activeRepairs.some(active => overlaps(active.repairOf!, candidate))) return true
    if (proposedRepairs.slice(0, index).some(prior => overlaps(prior, candidate))) return true
  }
  return false
}
