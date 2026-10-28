import { parseDiscoveryQueryFootprint, type DiscoveryQueryFootprint } from "../subagents/child-discovery-query-footprint.js"
import { validateTaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import type { TaskGraphCurrentNode, TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"

export type RootTaskHistoryDiscoveryFootprint = DiscoveryQueryFootprint
type Row = Record<string, unknown>

function record(value: unknown): Row | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Row : null
  } catch { return null }
}

function own(value: object, key: string): { present: boolean; value?: unknown } | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return { present: false }
    return descriptor.enumerable && "value" in descriptor ? { present: true, value: descriptor.value } : null
  } catch { return null }
}

function eligibleScout(value: unknown): value is TaskGraphCurrentNode {
  const node = record(value), templateId = node && own(node, "templateId"), status = node && own(node, "status")
  const verification = node && own(node, "verification")
  if (!node || !templateId?.present || templateId.value !== "scout" || !status?.present
    || status.value !== "completed" && status.value !== "failed" || !verification?.present
    || !validateTaskGraphVerificationContract(verification.value, "scout").ok) return false
  for (const key of ["repairOf", "repairReceipt", "native", "nativeResult"]) {
    const value = own(node, key)
    if (!value || value.present) return false
  }
  return true
}

/** Revalidates the #995 projection and its already-validated typed Scout node. */
export function projectRootTaskHistoryDiscoveryFootprint(node: unknown): RootTaskHistoryDiscoveryFootprint | undefined {
  if (!eligibleScout(node)) return undefined
  const property = own(node, "discoveryQueryFootprint")
  return property?.present ? parseDiscoveryQueryFootprint(property.value) ?? undefined : undefined
}

/** Keeps only the exact ordinary marker for the history serializer to consume and strip. */
export function projectRootTaskHistoryGraph(source: TaskGraphCurrentState, historicalOnly: boolean): TaskGraphCurrentState {
  const ordinary = !historicalOnly && own(source, "discoveryTurnEligibility")?.value === "ordinary"
  const nodes = source.nodes.map(node => {
    const { discoveryQueryFootprint: _privateFootprint, ...safeNode } = node
    const footprint = ordinary ? projectRootTaskHistoryDiscoveryFootprint(node) : undefined
    return footprint ? { ...safeNode, discoveryQueryFootprint: footprint } : safeNode
  })
  return { revision: source.revision, nodes, ...(ordinary ? { discoveryTurnEligibility: "ordinary" as const } : {}) }
}
