import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { taskGraphLifecycleKey } from "./task-graph-receipt-keys.js"
export { taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-receipt-keys.js"
import { isValidTaskGraphRepairRelation, TASK_GRAPH_LIMITS, type TaskGraphEvent, type TaskGraphNodeProposal, type TaskGraphState, type TaskGraphVerificationDisposition } from "../planning/task-graph.js"
import { taskGraphVerificationRole, validateTaskGraphVerificationContract, validateTaskGraphVerificationDependencySelectors, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import type { SubagentTaskStatus } from "./types.js"
import { parseTaskGraphNativeDelegation, TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"
import { parseRegisteredScoutEnvelope, taskGraphNodeKeysMatch, type RegisteredScoutEnvelope } from "./task-graph-command-port.js"
import { APPLICATION_FILLER_TEMPLATE_ID } from "./role-policy.js"
import { OBJECTIVE_TAILOR_GRAPH_MAX_NODES, parseObjectiveTailorGraph, SELECTED_JOB_BATCH_TEMPLATE_CATALOG,
  type ObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import { readPinnedRootCriteria } from "./root-plan-criteria.js"
import { parseTaskGraphSnapshotPackageRefs, taskGraphSnapshotCapacityValid, taskGraphSnapshotExactKeys as exactKeys,
  taskGraphSnapshotObject as object, taskGraphSnapshotOwnData, taskGraphSnapshotRepairOf as parsedRepairOf,
  taskGraphSnapshotStringList as stringList, taskGraphSnapshotText as text } from "./task-graph-snapshot-capacity.js"

export const TASK_GRAPH_ITEM_TYPE = "task_graph"
export const TASK_GRAPH_SNAPSHOT_VERSION = "agent-harness.v2.task-graph"

export type { TaskGraphVerificationDisposition } from "../planning/task-graph.js"
export type StoredTaskGraphNode = TaskGraphNodeProposal & Readonly<{
  depth: number
  taskId: string
  verification?: TaskGraphVerificationContract
  verificationDisposition?: TaskGraphVerificationDisposition
  registeredScoutEnvelope?: RegisteredScoutEnvelope
}>
export type TaskGraphSnapshot = Readonly<{
  schemaVersion: typeof TASK_GRAPH_SNAPSHOT_VERSION
  nodes: readonly StoredTaskGraphNode[]
  rootSuccessCriteria?: readonly string[]
  objectiveTailor?: ObjectiveTailorGraph
}>

const MAX_OBJECTIVE_TAILOR_NODES = OBJECTIVE_TAILOR_GRAPH_MAX_NODES, MAX_SNAPSHOT_BYTES = TASK_GRAPH_LIMITS.maxSnapshotBytes
const MAX_LEGACY_NODES = TASK_GRAPH_LIMITS.maxPersistedNodes
const MAX_DEPTH = TASK_GRAPH_LIMITS.maxDepth, MAX_KEY_LENGTH = TASK_GRAPH_LIMITS.maxKeyLength
const MAX_TEMPLATE_ID_LENGTH = TASK_GRAPH_LIMITS.maxTemplateIdLength, MAX_GOAL_LENGTH = TASK_GRAPH_LIMITS.maxGoalLength
const MAX_CRITERIA = TASK_GRAPH_LIMITS.maxSuccessCriteria, MAX_CRITERION_LENGTH = TASK_GRAPH_LIMITS.maxCriterionLength
const MAX_DEPENDENCIES = TASK_GRAPH_LIMITS.maxDependencies, MAX_TASK_ID_LENGTH = TASK_GRAPH_LIMITS.maxKeyLength

const LEGACY_NODE_KEYS = "dependsOn,depth,goal,key,successCriteria,taskId,templateId"
const NODE_KEYS_WITH_DISPOSITION = `${LEGACY_NODE_KEYS},verificationDisposition`
const NODE_KEYS_WITH_VERIFICATION = `${LEGACY_NODE_KEYS},verification,verificationDisposition`
const NODE_KEYS_WITH_REPAIR = "dependsOn,depth,goal,key,repairOf,successCriteria,taskId,templateId,verification,verificationDisposition"
const NATIVE_NODE_KEYS = "dependsOn,depth,goal,key,nativeDelegation,successCriteria,taskId,templateId,verificationDisposition"
const SPECIALIZED_TEMPLATE_IDS = new Set(["cover_letter_writer", "cover_letter_reviewer", APPLICATION_FILLER_TEMPLATE_ID, "prepare", "gate", "scheduled_audit", "scheduled.application.execute", "scheduled.post_gate_audit",
  ...SELECTED_JOB_BATCH_TEMPLATE_CATALOG.flatMap(entry => [entry.writerTemplateId, entry.reviewerTemplateId])])

const TASK_STATUSES = new Set<SubagentTaskStatus>([
  "queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed",
])

export function parseTaskGraphSnapshot(value: unknown): TaskGraphSnapshot {
  const row = object(value)
  const objectiveField = row ? taskGraphSnapshotOwnData(row, "objectiveTailor") : { present: false, valid: true }
  const pinnedShape = row !== null && exactKeys(row, "nodes,rootSuccessCriteria,schemaVersion")
  const objectiveShape = row !== null && exactKeys(row, "nodes,objectiveTailor,schemaVersion")
  const pinnedObjectiveShape = row !== null && exactKeys(row, "nodes,objectiveTailor,rootSuccessCriteria,schemaVersion")
  const maxNodes = objectiveField.present ? MAX_OBJECTIVE_TAILOR_NODES : MAX_LEGACY_NODES
  if (!row || !objectiveField.valid || !(pinnedShape || objectiveShape || pinnedObjectiveShape || exactKeys(row, "nodes,schemaVersion"))
    || row.schemaVersion !== TASK_GRAPH_SNAPSHOT_VERSION
    || !Array.isArray(row.nodes) || row.nodes.length > maxNodes) throw new Error("task_graph_snapshot_invalid")
  const rawObjectiveTailor = objectiveField.present ? parseObjectiveTailorGraph(objectiveField.value, row.nodes) ?? undefined : undefined
  if (objectiveField.present && !rawObjectiveTailor) throw new Error("task_graph_snapshot_objective_tailor_invalid")
  const hasPinnedCriteria = pinnedShape || pinnedObjectiveShape
  const rootSuccessCriteria = hasPinnedCriteria ? readPinnedRootCriteria(row) : undefined
  if (hasPinnedCriteria && (!rootSuccessCriteria?.length)) throw new Error("task_graph_snapshot_root_criteria_invalid")
  const keys = new Set<string>()
  const ids = new Set<string>()
  const nodes: StoredTaskGraphNode[] = []
  for (const value of row.nodes) {
    const node = object(value)
    const oldShape = node !== null && taskGraphNodeKeysMatch(node, LEGACY_NODE_KEYS)
    const dispositionShape = node !== null && taskGraphNodeKeysMatch(node, NODE_KEYS_WITH_DISPOSITION)
    const verificationShape = node !== null && taskGraphNodeKeysMatch(node, NODE_KEYS_WITH_VERIFICATION)
    const repairShape = node !== null && taskGraphNodeKeysMatch(node, NODE_KEYS_WITH_REPAIR)
    const packageRefs = node ? parseTaskGraphSnapshotPackageRefs(node) : { valid: false, shape: false, packageRefs: undefined }
    const packageRefsShape = packageRefs.shape
    const nativeShape = node !== null && exactKeys(node, NATIVE_NODE_KEYS)
    if (!node || (!oldShape && !dispositionShape && !verificationShape && !repairShape && !packageRefsShape && !nativeShape)
      || !text(node.key, MAX_KEY_LENGTH) || !text(node.templateId, MAX_TEMPLATE_ID_LENGTH)
      || !text(node.goal, nativeShape ? 4_000 : MAX_GOAL_LENGTH) || !text(node.taskId, MAX_TASK_ID_LENGTH)
      || !stringList(node.successCriteria, nativeShape ? 32 : MAX_CRITERIA, nativeShape ? 1_000 : MAX_CRITERION_LENGTH, nativeShape)
      || !stringList(node.dependsOn, MAX_DEPENDENCIES, MAX_KEY_LENGTH, true)
      || !packageRefs.valid
      || !Number.isSafeInteger(node.depth) || Number(node.depth) < 1 || Number(node.depth) > MAX_DEPTH) throw new Error("task_graph_snapshot_invalid")
    const hasVerification = Object.hasOwn(node, "verification")
    const hasRepair = Object.hasOwn(node, "repairOf")
    const hasRegisteredScoutEnvelope = Object.hasOwn(node, "registeredScoutEnvelope")
    const hasDisposition = dispositionShape || verificationShape || repairShape || packageRefsShape || nativeShape
    const declaredDisposition = hasDisposition ? node.verificationDisposition : undefined
    const verificationDisposition = hasDisposition ? declaredDisposition : (hasVerification ? "typed" : "legacy_unverified")
    if (verificationDisposition !== "typed" && verificationDisposition !== "legacy_unverified" && verificationDisposition !== "specialized") {
      throw new Error("task_graph_snapshot_invalid")
    }
    let verification: TaskGraphVerificationContract | undefined
    if (verificationDisposition === "typed") {
      const parsed = validateTaskGraphVerificationContract(node.verification, node.templateId)
      if (!hasVerification || !parsed.ok) throw new Error("task_graph_snapshot_verification_invalid")
      verification = parsed.contract
    } else if (verificationDisposition === "specialized") {
      if (hasVerification || !SPECIALIZED_TEMPLATE_IDS.has(node.templateId)) throw new Error("task_graph_snapshot_verification_disposition_invalid")
    } else if (hasVerification) {
      throw new Error("task_graph_snapshot_verification_disposition_invalid")
    }
    const repairOf = hasRepair ? parsedRepairOf(node.repairOf, MAX_KEY_LENGTH, MAX_CRITERIA) : undefined
    if (hasRepair && !repairOf) throw new Error("task_graph_snapshot_repair_invalid")
    const nativeDelegation = nativeShape ? parseTaskGraphNativeDelegation(node.nativeDelegation) : undefined
    if (nativeShape && (!nativeDelegation || node.templateId !== TASK_GRAPH_NATIVE_TEMPLATE_ID || verificationDisposition !== "legacy_unverified")) throw new Error("task_graph_snapshot_native_delegation_invalid")
    const registeredScoutEnvelope = hasRegisteredScoutEnvelope ? parseRegisteredScoutEnvelope(node.registeredScoutEnvelope) : undefined
    if (hasRegisteredScoutEnvelope && (node.templateId !== "scout" || verificationDisposition !== "typed" || !registeredScoutEnvelope)) throw new Error("task_graph_snapshot_registered_scout_envelope_invalid")
    if (keys.has(node.key) || ids.has(node.taskId)) throw new Error("task_graph_snapshot_duplicate")
    keys.add(node.key); ids.add(node.taskId)
    nodes.push({
      key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria,
      dependsOn: node.dependsOn, depth: Number(node.depth), taskId: node.taskId, verificationDisposition,
      ...(verification ? { verification } : {}),
      ...(repairOf ? { repairOf } : {}),
      ...(packageRefs.packageRefs ? { packageRefs: packageRefs.packageRefs } : {}),
      ...(nativeDelegation ? { nativeDelegation } : {}),
      ...(registeredScoutEnvelope ? { registeredScoutEnvelope } : {}),
    })
  }
  const positions = new Map(nodes.map((node, index) => [node.key, index] as const))
  for (const [index, node] of nodes.entries()) if (node.repairOf) {
    const targetIndex = positions.get(node.repairOf.nodeKey)
    const target = targetIndex === undefined ? undefined : nodes[targetIndex]
    if (targetIndex === undefined || targetIndex >= index || !target || !isValidTaskGraphRepairRelation(node, target)) throw new Error("task_graph_snapshot_repair_invalid")
  }
  const indegree = new Map<string, number>(nodes.map(node => [node.key, 0] as const))
  const children = new Map(nodes.map(node => [node.key, [] as string[]] as const))
  for (const node of nodes) {
    const dependencies = new Set<string>()
    for (const dependency of node.dependsOn) {
      if (!keys.has(dependency) || dependencies.has(dependency)) throw new Error("task_graph_snapshot_dependency_invalid")
      dependencies.add(dependency)
      indegree.set(node.key, indegree.get(node.key)! + 1)
      children.get(dependency)!.push(node.key)
    }
  }
  if (!validateTaskGraphVerificationDependencySelectors(nodes)) throw new Error("task_graph_snapshot_verification_dependency_invalid")
  const ready = nodes.filter(node => indegree.get(node.key) === 0).map(node => node.key)
  let visited = 0
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const key = ready[cursor]!
    visited++
    for (const child of children.get(key)!) {
      indegree.set(child, indegree.get(child)! - 1)
      if (indegree.get(child) === 0) ready.push(child)
    }
  }
  if (visited !== nodes.length) throw new Error("task_graph_snapshot_cycle_invalid")
  const objectiveTailor = rawObjectiveTailor ? parseObjectiveTailorGraph(rawObjectiveTailor, nodes) ?? undefined : undefined
  if (rawObjectiveTailor && !objectiveTailor) throw new Error("task_graph_snapshot_objective_tailor_invalid")
  if (!objectiveTailor && !taskGraphSnapshotCapacityValid(nodes)) throw new Error("task_graph_snapshot_capacity_invalid")
  const snapshot: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes,
    ...(rootSuccessCriteria ? { rootSuccessCriteria } : {}), ...(objectiveTailor ? { objectiveTailor } : {}) }
  assertTaskGraphSnapshotSize(snapshot)
  return snapshot
}

export function taskGraphSnapshot(state: TaskGraphState & Readonly<{ rootSuccessCriteria?: readonly string[]; objectiveTailor?: ObjectiveTailorGraph }>, taskIds: ReadonlyMap<string, string>, rootSuccessCriteria = state.rootSuccessCriteria): TaskGraphSnapshot {
  const snapshot = {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: state.nodes.map(node => {
      const taskId = taskIds.get(node.key)
      if (!taskId) throw new Error("task_graph_task_id_missing")
      const { status: _status, failureReason: _failureReason, ...stored } = node
      const existingDisposition = node.verificationDisposition
      const role = taskGraphVerificationRole(node.templateId)
      if (!role && !SPECIALIZED_TEMPLATE_IDS.has(node.templateId) && existingDisposition !== "legacy_unverified") {
        throw new Error("task_graph_snapshot_template_unsupported")
      }
      const verificationDisposition = existingDisposition ?? (node.verification ? "typed" : role ? "legacy_unverified" : "specialized")
      return { ...stored, taskId, verificationDisposition }
    }), ...(rootSuccessCriteria ? { rootSuccessCriteria } : {}),
    ...(Object.hasOwn(state, "objectiveTailor") ? { objectiveTailor: state.objectiveTailor } : {}),
  }
  return parseTaskGraphSnapshot(snapshot)
}

function assertTaskGraphSnapshotSize(snapshot: TaskGraphSnapshot): void {
  const bytes = Buffer.byteLength(canonicalTaskGraphJson(snapshot), "utf8")
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("task_graph_snapshot_too_large")
}

export function taskGraphWaitLifecycleKey(parentTaskId: string, nodeKey: string, attempt: number, waitRowId: string, type: "task.waiting" | "task.queued" | "task.started" = "task.waiting", dispatchGeneration?: number): string {
  if (typeof waitRowId !== "string" || !waitRowId.trim() || waitRowId.trim() !== waitRowId || waitRowId.length > MAX_TASK_ID_LENGTH
    || type !== "task.waiting" && type !== "task.queued" && type !== "task.started"
    || (type === "task.started" ? typeof dispatchGeneration !== "number" || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 0 : dispatchGeneration !== undefined)) throw new Error("task_graph_wait_identity_invalid")
  return `${taskGraphLifecycleKey(parentTaskId, nodeKey, attempt, type)}:wait:${createHash("sha256").update(dispatchGeneration === undefined ? waitRowId : JSON.stringify([waitRowId, dispatchGeneration])).digest("hex")}`
}
export function taskGraphState(
  snapshot: TaskGraphSnapshot,
  revision: number,
  statuses: ReadonlyMap<string, { status: SubagentTaskStatus; failureReason: string | null }>,
  events: readonly TaskGraphEvent[],
): TaskGraphState & Readonly<{ rootSuccessCriteria?: readonly string[]; objectiveTailor?: ObjectiveTailorGraph }> {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("task_graph_revision_invalid")
  return {
    revision,
    nodes: snapshot.nodes.map(node => {
      const current = statuses.get(node.taskId)
      if (!current || !TASK_STATUSES.has(current.status)) throw new Error("task_graph_task_missing")
      return { ...node, status: current.status, ...(current.failureReason ? { failureReason: current.failureReason } : {}) }
    }),
    appliedEvents: events, ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}),
    ...(snapshot.objectiveTailor ? { objectiveTailor: snapshot.objectiveTailor } : {}),
  }
}

export function canonicalTaskGraphJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskGraphJson).join(",")}]`
  const row = object(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalTaskGraphJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError("task_graph_json_invalid")
  return encoded
}

export function taskGraphFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex")
}
export function parseTaskGraphEvent(value: unknown): TaskGraphEvent | null {
  const row = object(value)
  if (!row || !text(row.type) || !text(row.idempotencyKey) || !text(row.nodeKey)
    || !Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 0) return null
  const allowed = new Set(["task.started", "task.queued", "task.gate_choice_resumed", "task.waiting", "task.waiting_for_user", "task.retrying", "task.completed", "task.failed", "task.interrupted", "task.cancelled", "task.closed"])
  if (!allowed.has(row.type)) return null
  const keys = row.type === "task.failed" ? "expectedRevision,failureReason,idempotencyKey,nodeKey,type"
    : row.type === "task.gate_choice_resumed" ? "expectedRevision,gateTaskId,idempotencyKey,nodeKey,requestAttemptCount,resumedAttemptCount,type"
      : "expectedRevision,idempotencyKey,nodeKey,type"
  if (Object.keys(row).sort().join(",") !== keys) return null
  if (row.type === "task.failed") return text(row.failureReason) ? row as unknown as TaskGraphEvent : null
  if (row.type === "task.gate_choice_resumed" && (!text(row.gateTaskId) || !Number.isSafeInteger(row.requestAttemptCount)
    || Number(row.requestAttemptCount) < 1 || !Number.isSafeInteger(row.resumedAttemptCount)
    || Number(row.resumedAttemptCount) !== Number(row.requestAttemptCount) + 1)) return null
  return row as unknown as TaskGraphEvent
}
