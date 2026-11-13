import type { TaskGraphNodeProposal, TaskGraphVerificationDisposition } from "./task-graph.js"
import { taskGraphVerificationRole, validateTaskGraphVerificationContract } from "./task-graph-verification.js"

type RepairTarget = TaskGraphNodeProposal & Readonly<{
  taskId?: string
  verificationDisposition?: TaskGraphVerificationDisposition
}>

/** A repair covers its failed criteria and carries every target location check as an inherited guard. */
export function isValidTaskGraphRepairRelation(node: TaskGraphNodeProposal, target: RepairTarget): boolean {
  const relation = node.repairOf, role = taskGraphVerificationRole(node.templateId)
  const targetResult = validateTaskGraphVerificationContract(target.verification, target.templateId)
  const repairResult = validateTaskGraphVerificationContract(node.verification, node.templateId)
  if (!relation || !role || node.templateId !== target.templateId || relation.nodeKey !== target.key
    || relation.taskId !== target.taskId || !relation.graphRootTaskId.trim()
    || target.verificationDisposition === "legacy_unverified" || target.verificationDisposition === "specialized"
    || node.dependsOn.includes(target.key) || !targetResult.ok || !repairResult.ok
    || relation.criterionIds.length === 0 || new Set(relation.criterionIds).size !== relation.criterionIds.length) return false

  const targetCriteria = new Map(targetResult.contract.criteria.map(item => [item.id, item.check] as const))
  const relationIds = new Set(relation.criterionIds)
  if (!relation.criterionIds.every(id => targetCriteria.has(id))) return false

  const requiredIds = new Set(relationIds)
  for (const criterion of targetResult.contract.criteria) {
    if (criterion.check.kind === "candidate_location_in") requiredIds.add(criterion.id)
  }
  if (repairResult.contract.criteria.length !== requiredIds.size) return false
  return repairResult.contract.criteria.every(item => requiredIds.has(item.id)
    && JSON.stringify(item.check) === JSON.stringify(targetCriteria.get(item.id)))
}
