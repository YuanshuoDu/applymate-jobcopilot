import { TASK_GRAPH_LIMITS } from "./task-graph.js"

export type TaskGraphCapacityFacts = Readonly<{
  nodeCount: number
  hasTypedVerification: boolean
  repairRecorded: boolean
}>

export type TaskGraphNodeCapacity = Readonly<{
  nodeCount: number
  maxNodes: typeof TASK_GRAPH_LIMITS.maxNodes
  remaining: number
  ordinaryRemaining: number
  reserveActive: boolean
  repairRecorded: boolean
}>

export function taskGraphNodeCapacity(value: unknown): TaskGraphNodeCapacity | undefined {
  const facts = parseFacts(value)
  if (!facts) return undefined
  const { nodeCount, hasTypedVerification, repairRecorded } = facts
  const maxNodes = TASK_GRAPH_LIMITS.maxNodes
  const reserveActive = hasTypedVerification && !repairRecorded && nodeCount < maxNodes
  const ordinaryLimit = hasTypedVerification && !repairRecorded ? maxNodes - 1 : maxNodes
  return {
    nodeCount, maxNodes, remaining: maxNodes - nodeCount,
    ordinaryRemaining: Math.max(0, ordinaryLimit - nodeCount), reserveActive, repairRecorded,
  }
}

function parseFacts(value: unknown): TaskGraphCapacityFacts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined
    const row = value as Record<string, unknown>
    if (Reflect.ownKeys(row).length !== 3 || Object.keys(row).sort().join(",") !== "hasTypedVerification,nodeCount,repairRecorded"
      || !Number.isSafeInteger(row.nodeCount) || typeof row.nodeCount !== "number"
      || row.nodeCount < 0 || row.nodeCount > TASK_GRAPH_LIMITS.maxNodes
      || typeof row.hasTypedVerification !== "boolean" || typeof row.repairRecorded !== "boolean"
      || row.repairRecorded && !row.hasTypedVerification) return undefined
    return { nodeCount: row.nodeCount, hasTypedVerification: row.hasTypedVerification, repairRecorded: row.repairRecorded }
  } catch { return undefined }
}
