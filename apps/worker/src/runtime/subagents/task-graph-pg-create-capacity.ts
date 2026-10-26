import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { taskGraphNodeCapacity } from "../planning/task-graph-capacity.js"

export type OperationalFailureCapacityReuse = Readonly<{
  originalNodeCount: number
  removedNodeCount: number
}>

export function taskGraphCreateCapacityAllowed(input: Readonly<{
  nodeCount: number
  proposalCount: number
  hasTypedVerification: boolean
  repairRecorded: boolean
  operationalFailureReuse?: OperationalFailureCapacityReuse
}>): boolean {
  const reuse = input.operationalFailureReuse
  if (reuse) return exactReplacementCapacity(input.nodeCount, input.proposalCount, reuse)
  const capacity = taskGraphNodeCapacity({
    nodeCount: input.nodeCount,
    hasTypedVerification: input.hasTypedVerification,
    repairRecorded: input.repairRecorded,
  })
  return Boolean(capacity && input.proposalCount <= capacity.ordinaryRemaining)
}

function exactReplacementCapacity(nodeCount: number, proposalCount: number, reuse: OperationalFailureCapacityReuse): boolean {
  const { originalNodeCount, removedNodeCount } = reuse
  return Number.isSafeInteger(originalNodeCount) && Number.isSafeInteger(removedNodeCount)
    && originalNodeCount >= 1 && originalNodeCount <= TASK_GRAPH_LIMITS.maxNodes
    && removedNodeCount >= 1 && removedNodeCount <= originalNodeCount
    && nodeCount + removedNodeCount === originalNodeCount
    && proposalCount === removedNodeCount && nodeCount + proposalCount === originalNodeCount
}
