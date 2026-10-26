import {
  parseSteeringReconciliationReceipt,
  STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION,
  STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION,
  STEERING_RECONCILIATION_OPERATIONAL_FAILURE_SCHEMA_VERSION,
  STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
  STEERING_RECONCILIATION_EVENT_TYPE,
  type SteeringReconciliationOperation,
  type SteeringReconciliationReceipt,
} from "./steering-reconciliation-contract.js"
import { parseTaskGraphBranchReplacement, type TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import type { TaskGraphSupersessionRelation } from "./task-graph-pg-supersession.js"
import type { TaskGraphBranchRepairRelation } from "./task-graph-pg-branch-repair-relation.js"
import type { TaskGraphFailedBranchRepairRelation } from "./task-graph-pg-failed-branch-relation.js"
import type { TaskGraphOperationalFailedBranchRelation } from "./task-graph-pg-operational-failed-branch-relation.js"

type Row = Record<string, unknown>

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Object.keys(value).length === Object.getOwnPropertyNames(value).length
    && Object.values(descriptors).every(item => item.enumerable && "value" in item) ? value as Row : null
}

export function matchSteeringReconciliationOperationReceipt(row: Readonly<Record<string, unknown>>, operation: SteeringReconciliationOperation,
  key: string, requestFingerprint?: string): SteeringReconciliationReceipt {
  const receipt = parseSteeringReconciliationReceipt(record(row.payload), operation.scope)
  const branch = operation.replaceBranch && parseTaskGraphBranchReplacement(operation.replaceBranch)
  const branchMatches = Boolean(branch?.ok && receipt?.branchRepair && receipt.branchRepair.operationKey === key
    && receipt.branchRepair.agentPlanCall.callId === operation.callId && receipt.branchRepair.agentPlanCall.stepId === operation.scope.stepId
    && JSON.stringify(branch.value) === JSON.stringify(receipt.branchRepair.agentPlanCall.replaceBranch)
    && requestFingerprint === receipt.branchRepair.replacementFingerprint)
  const failed = operation.replaceBranch && receipt?.failedBranch
  const failedBranchMatches = Boolean(failed && failed.operationKey === key && failed.agentPlanCall.callId === operation.callId
    && failed.agentPlanCall.stepId === operation.scope.stepId && branch?.ok
    && JSON.stringify(branch.value) === JSON.stringify(failed.agentPlanCall.replaceBranch) && requestFingerprint === failed.requestFingerprint)
  const failedReplacement = operation.replaceOperationalFailure && receipt?.operationalFailure
  const operationalMatches = Boolean(failedReplacement && failedReplacement.operationKey === key
    && failedReplacement.agentPlanCall.callId === operation.callId && failedReplacement.agentPlanCall.stepId === operation.scope.stepId
    && JSON.stringify(operation.replaceOperationalFailure) === JSON.stringify(failedReplacement.agentPlanCall.replaceOperationalFailure)
    && (requestFingerprint === undefined || requestFingerprint === failedReplacement.requestFingerprint))
  if (!receipt || row.turnId !== operation.scope.turnId || row.type !== STEERING_RECONCILIATION_EVENT_TYPE || row.itemId !== null
    || row.taskId !== operation.scope.rootTaskId || row.actor !== "orchestrator" || row.correlationId !== operation.scope.turnId
    || row.causationId !== operation.scope.stepId || row.idempotencyKey !== key || row.hasOutbox !== false
    || receipt.decision !== operation.decision || receipt.observedRevision !== operation.expectedRevision
    || operation.replaceUnstartedNodeKey === undefined && receipt.supersession !== undefined
    || operation.replaceUnstartedNodeKey !== undefined && (!receipt.supersession || receipt.supersession.operationKey !== key
      || receipt.supersession.agentPlanCall.callId !== operation.callId || receipt.supersession.agentPlanCall.stepId !== operation.scope.stepId
      || receipt.supersession.agentPlanCall.replaceUnstarted.nodeKey !== operation.replaceUnstartedNodeKey)
    || operation.replaceBranch === undefined && (receipt.branchRepair !== undefined || receipt.failedBranch !== undefined)
    || operation.replaceBranch !== undefined && !branchMatches && !failedBranchMatches
    || operation.replaceOperationalFailure === undefined && receipt.operationalFailure !== undefined
    || operation.replaceOperationalFailure !== undefined && (!operationalMatches || operation.replaceBranch !== undefined
      || operation.replaceUnstartedNodeKey !== undefined || receipt.branchRepair !== undefined || receipt.failedBranch !== undefined || receipt.supersession !== undefined)) {
    throw new Error("steering_reconciliation_idempotency_conflict")
  }
  return receipt
}

export function relationReceipt(base: SteeringReconciliationReceipt, relation: TaskGraphSupersessionRelation): SteeringReconciliationReceipt {
  return { ...base, schemaVersion: STEERING_RECONCILIATION_SUPERSESSION_SCHEMA_VERSION,
    resultingRevision: relation.resultingRevision, supersession: relation }
}
export function branchRepairReceipt(base: SteeringReconciliationReceipt, relation: TaskGraphBranchRepairRelation): SteeringReconciliationReceipt {
  return { ...base, schemaVersion: STEERING_RECONCILIATION_BRANCH_REPAIR_SCHEMA_VERSION,
    resultingRevision: relation.resultingRevision, branchRepair: relation }
}
export function failedBranchRepairReceipt(base: SteeringReconciliationReceipt, relation: TaskGraphFailedBranchRepairRelation): SteeringReconciliationReceipt {
  return { ...base, schemaVersion: STEERING_RECONCILIATION_FAILED_BRANCH_REPAIR_SCHEMA_VERSION,
    resultingRevision: relation.resultingRevision, failedBranch: relation }
}
export function operationalFailureReceipt(base: SteeringReconciliationReceipt,
  relation: TaskGraphOperationalFailedBranchRelation): SteeringReconciliationReceipt {
  return { ...base, schemaVersion: STEERING_RECONCILIATION_OPERATIONAL_FAILURE_SCHEMA_VERSION,
    resultingRevision: relation.resultingRevision, operationalFailure: relation }
}
