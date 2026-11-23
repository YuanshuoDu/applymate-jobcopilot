import {
  parseTaskGraphFailedBranchRepairRelation,
  type TaskGraphFailedBranchReconciliationCodecs,
  type TaskGraphFailedBranchRepairRelation,
} from "./task-graph-failed-branch-relation.js"

export {
  parseTaskGraphBranchReplacementContract,
  TASK_GRAPH_BRANCH_KEY_MAX_LENGTH,
  TASK_GRAPH_MAX_PROPOSAL_NODES,
} from "./task-graph-branch-replacement-contract.js"
export type {
  TaskGraphBranchReplacementContract,
  TaskGraphBranchReplacementContractParse,
} from "./task-graph-branch-replacement-contract.js"
export {
  parseTaskGraphFailedBranchRepairRelation,
  taskGraphItemId,
  taskGraphLifecycleKey,
  taskGraphProposalKey,
  TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
} from "./task-graph-failed-branch-relation.js"
export type {
  TaskGraphFailedBranchIdentity,
  TaskGraphFailedBranchEventIdentity,
  TaskGraphFailedBranchReconciliationCodecs,
  TaskGraphFailedBranchRepairRelation,
} from "./task-graph-failed-branch-relation.js"

export const TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION = "agent-harness.v2.plan-reconciliation.v4" as const
export const TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_MAX_BYTES = 16 * 1024
export const TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_MAX_INPUTS = 128

const MAX_SEQUENCE = 9_223_372_036_854_775_807n
type Row = Record<string, unknown>

export type TaskGraphFailedBranchReconciliationExpected = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  stepId?: string
}>

export type TaskGraphFailedBranchReconciliationReceipt = Readonly<{
  schemaVersion: typeof TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION
  sessionId: string
  turnId: string
  rootTaskId: string
  stepId: string
  decision: "revise"
  observedRevision: number
  resultingRevision: number
  steerInputIds: readonly string[]
  inputCheckpoint: Readonly<{ throughSequence: string }>
  failedBranch: TaskGraphFailedBranchRepairRelation
}>

function record(value: unknown): Row | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => typeof key === "string"
      && descriptors[key]?.enumerable && "value" in descriptors[key]!) ? value as Row : null
  } catch { return null }
}
function exact(row: Row | null, keys: readonly string[]): row is Row {
  return row !== null && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key))
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function sequence(value: unknown): boolean {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_SEQUENCE
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false
  return BigInt(value) <= MAX_SEQUENCE
}
function validCodecs(codecs: TaskGraphFailedBranchReconciliationCodecs): boolean {
  return Boolean(codecs && typeof codecs.sha256 === "function" && typeof codecs.utf8ByteLength === "function")
}
function digest(codecs: TaskGraphFailedBranchReconciliationCodecs, value: string): string {
  const result = codecs.sha256(value)
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error("task_graph_hash_codec_invalid")
  return result
}

/** Derives the persisted operation key from the authenticated owner and exact receipt identity. */
export function taskGraphFailedBranchReconciliationOperationKey(
  scope: TaskGraphFailedBranchReconciliationExpected,
  callId: string,
  codecs: TaskGraphFailedBranchReconciliationCodecs,
): string | null {
  try {
    if (!validCodecs(codecs) || !validId(scope.userId) || !validId(scope.sessionId) || !validId(scope.turnId)
      || !validId(scope.rootTaskId) || (scope.stepId !== undefined && !validId(scope.stepId)) || !validId(callId)) return null
    const identity = JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.stepId, callId])
    return `agent.plan.reconciliation:sha256:${digest(codecs, identity)}`
  } catch { return null }
}

/** Parses the closed v4 envelope and nested relation; DB replay provenance remains Worker-owned. */
export function parseTaskGraphFailedBranchReconciliationReceipt(
  value: unknown,
  codecs: TaskGraphFailedBranchReconciliationCodecs,
  expected?: TaskGraphFailedBranchReconciliationExpected,
): TaskGraphFailedBranchReconciliationReceipt | null {
  try {
    if (!validCodecs(codecs)) return null
    const row = record(value)
    const baseKeys = ["schemaVersion", "sessionId", "turnId", "rootTaskId", "stepId", "decision", "observedRevision", "resultingRevision", "steerInputIds", "inputCheckpoint"]
    if (!exact(row, [...baseKeys, "failedBranch"]) || row.schemaVersion !== TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION
      || !validId(row.sessionId) || !validId(row.turnId) || !validId(row.rootTaskId) || !validId(row.stepId)
      || row.decision !== "revise" || !revision(row.observedRevision) || !revision(row.resultingRevision)
      || !Array.isArray(row.steerInputIds)) return null

    const failedBranch = parseTaskGraphFailedBranchRepairRelation(row.failedBranch, codecs)
    if (!failedBranch || failedBranch.graphRootTaskId !== row.rootTaskId || failedBranch.observedRevision !== row.observedRevision
      || failedBranch.resultingRevision !== row.resultingRevision || failedBranch.agentPlanCall.stepId !== row.stepId) return null

    const inputIds = row.steerInputIds as unknown[]
    if (inputIds.length > TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_MAX_INPUTS || !inputIds.every(validId)
      || new Set(inputIds).size !== inputIds.length
      || inputIds.some((id, index) => index > 0 && String(inputIds[index - 1]) >= id)) return null
    const checkpoint = record(row.inputCheckpoint)
    if (!exact(checkpoint, ["throughSequence"]) || !sequence(checkpoint.throughSequence)) return null

    if (expected) {
      if (!validId(expected.userId) || !validId(expected.sessionId) || !validId(expected.turnId) || !validId(expected.rootTaskId)
        || expected.stepId !== undefined && !validId(expected.stepId)
        || row.sessionId !== expected.sessionId || row.turnId !== expected.turnId || row.rootTaskId !== expected.rootTaskId
        || expected.stepId !== undefined && row.stepId !== expected.stepId
        || failedBranch.operationKey !== taskGraphFailedBranchReconciliationOperationKey({ ...expected, stepId: row.stepId },
          failedBranch.agentPlanCall.callId, codecs)) return null
    }

    const receipt = { ...row, failedBranch } as unknown as TaskGraphFailedBranchReconciliationReceipt
    const serialized = JSON.stringify(receipt)
    const byteLength = codecs.utf8ByteLength(serialized)
    return Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_MAX_BYTES
      ? receipt : null
  } catch { return null }
}
