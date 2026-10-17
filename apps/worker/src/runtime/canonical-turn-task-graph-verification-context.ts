import { Buffer } from "node:buffer"
import {
  isValidTaskGraphRepairRelation,
  type TaskGraphNodeProposal, type TaskGraphRepairOf,
} from "./planning/task-graph.js"
import {
  validateTaskGraphVerificationContract,
  validateTaskGraphVerificationDependencySelectors,
  type TaskGraphVerificationContract,
} from "./planning/task-graph-verification.js"
import {
  parseTaskGraphRepairOf,
  parseTaskGraphRepairReceipt,
  parseTaskGraphVerificationCriterionIds,
  parseTaskGraphVerificationReport,
  type TaskGraphCurrentNode,
  type TaskGraphRepairReceipt,
  type TaskGraphVerificationReport,
} from "./subagents/task-graph-command-port.js"

export type TaskGraphCurrentVerificationMetadata = Readonly<{
  verificationCriterionIds?: string[]
  verification?: TaskGraphVerificationContract
  verificationReport?: TaskGraphVerificationReport
  repairOf?: TaskGraphRepairOf
  repairReceipt?: TaskGraphRepairReceipt
}>

type OwnValue = Readonly<{ present: false }> | Readonly<{ present: true; value: unknown }>
const ABSENT: OwnValue = { present: false }

function ownValue(row: Record<string, unknown>, key: string): OwnValue | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    if (!descriptor) return ABSENT
    if (!descriptor.enumerable || !("value" in descriptor)) return undefined
    return { present: true, value: descriptor.value }
  } catch { return undefined }
}

function strictCriterionIds(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 8
      || Reflect.ownKeys(value).length !== Number(length) + 1) return undefined
    for (let index = 0; index < Number(length); index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined
    }
    return parseTaskGraphVerificationCriterionIds(value)
  } catch { return undefined }
}

/** Parses only explicitly supplied current verification metadata; absent contracts keep the legacy projection. */
export function parseTaskGraphCurrentVerificationMetadata(
  row: Record<string, unknown>, templateId: string, nodeKey: string, taskId: string,
): TaskGraphCurrentVerificationMetadata | undefined {
  const idsValue = ownValue(row, "verificationCriterionIds")
  const contractValue = ownValue(row, "verification")
  const reportValue = ownValue(row, "verificationReport")
  const repairValue = ownValue(row, "repairOf")
  const receiptValue = ownValue(row, "repairReceipt")
  if (!idsValue || !contractValue || !reportValue || !repairValue || !receiptValue) return undefined

  const verificationCriterionIds = idsValue.present ? strictCriterionIds(idsValue.value) : undefined
  if (idsValue.present && !verificationCriterionIds) return undefined
  let verification: TaskGraphVerificationContract | undefined
  if (contractValue.present) {
    if (!verificationCriterionIds) return undefined
    const parsed = validateTaskGraphVerificationContract(contractValue.value, templateId)
    if (!parsed.ok || parsed.contract.criteria.length !== verificationCriterionIds.length
      || parsed.contract.criteria.some((criterion, index) => criterion.id !== verificationCriterionIds[index])) return undefined
    verification = parsed.contract
  }
  const verificationReport = reportValue.present && verificationCriterionIds
    ? parseTaskGraphVerificationReport(reportValue.value, verificationCriterionIds) : undefined
  const repairOf = repairValue.present ? parseTaskGraphRepairOf(repairValue.value) : undefined
  const repairReceipt = receiptValue.present ? parseTaskGraphRepairReceipt(receiptValue.value, {
    repairOf, repairNodeKey: nodeKey, repairTaskId: taskId, report: verificationReport,
  }) : undefined
  if (reportValue.present && !verificationReport || repairValue.present && !repairOf || receiptValue.present && !repairReceipt) return undefined
  return {
    ...(verificationCriterionIds ? { verificationCriterionIds } : {}),
    ...(verification ? { verification } : {}), ...(verificationReport ? { verificationReport } : {}),
    ...(repairOf ? { repairOf } : {}), ...(repairReceipt ? { repairReceipt } : {}),
  }
}

function proposal(node: TaskGraphCurrentNode): TaskGraphNodeProposal & Readonly<{
  taskId: string
  verificationDisposition: "typed" | "legacy_unverified"
}> {
  return {
    key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria,
    dependsOn: node.dependsOn, taskId: node.taskId,
    verificationDisposition: node.verification ? "typed" : "legacy_unverified",
    ...(node.verification ? { verification: node.verification } : {}), ...(node.repairOf ? { repairOf: node.repairOf } : {}),
  }
}

/** Validates identities and typed cross-node selectors from one current graph read. */
export function validateTaskGraphCurrentVerificationGraph(nodes: readonly TaskGraphCurrentNode[]): boolean {
  const byKey = new Map<string, TaskGraphCurrentNode>(), taskIds = new Set<string>()
  for (const node of nodes) {
    if (!node.key.trim() || byKey.has(node.key) || !node.taskId.trim() || taskIds.has(node.taskId)
      || new Set(node.dependsOn).size !== node.dependsOn.length) return false
    if (node.verification) {
      const parsed = validateTaskGraphVerificationContract(node.verification, node.templateId)
      if (!parsed.ok || !node.verificationCriterionIds
        || parsed.contract.criteria.length !== node.verificationCriterionIds.length
        || parsed.contract.criteria.some((criterion, index) => criterion.id !== node.verificationCriterionIds?.[index])) return false
    }
    byKey.set(node.key, node); taskIds.add(node.taskId)
  }
  if (nodes.some(node => node.dependsOn.some(key => !byKey.has(key)))) return false
  const selectors = nodes.map(node => ({ key: node.key, templateId: node.templateId, dependsOn: node.dependsOn,
    verificationDisposition: node.verification ? "typed" : undefined, ...(node.verification ? { verification: node.verification } : {}) }))
  if (!validateTaskGraphVerificationDependencySelectors(selectors)) return false
  for (const node of nodes) {
    if (!node.repairOf) continue
    const target = byKey.get(node.repairOf.nodeKey)
    if (!node.verification && !target?.verification) continue
    if (!target || !node.verification || !target.verification || node.repairOf.taskId !== target.taskId
      || !isValidTaskGraphRepairRelation(proposal(node), proposal(target))) return false
  }
  return true
}

/** Counts only the verifier metadata retained by this bounded model projection. */
export function taskGraphCurrentVerificationMetadataBytes(node: TaskGraphCurrentNode): number {
  return Buffer.byteLength(JSON.stringify({
    verificationCriterionIds: node.verificationCriterionIds, verification: node.verification,
    verificationReport: node.verificationReport, repairOf: node.repairOf, repairReceipt: node.repairReceipt,
  }), "utf8")
}
