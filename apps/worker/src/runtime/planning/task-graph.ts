import type { SubagentTaskStatus } from "../subagents/types.js"
import type { TaskGraphNativeDelegationMetadata } from "../subagents/task-graph-native-state.js"
import { taskGraphVerificationRole, validateTaskGraphVerificationContract, type TaskGraphVerificationContract } from "./task-graph-verification.js"
export type TaskGraphNodeStatus = SubagentTaskStatus
export type TaskGraphVerificationDisposition = "typed" | "legacy_unverified" | "specialized"
export type TaskGraphRepairOf = Readonly<{ graphRootTaskId: string; nodeKey: string; taskId: string; criterionIds: string[] }>
export type TaskGraphNodeProposal = Readonly<{
  key: string; templateId: string; goal: string
  /** Explanatory instructions only; these strings are never treated as verification proof. */
  successCriteria: readonly string[]; dependsOn: readonly string[]
  verification?: TaskGraphVerificationContract; repairOf?: TaskGraphRepairOf; nativeDelegation?: TaskGraphNativeDelegationMetadata
}>
export type TaskGraphProposal = Readonly<{ expectedRevision: number; nodes: readonly TaskGraphNodeProposal[] }>
export type TaskGraphNode = TaskGraphNodeProposal & Readonly<{ depth: number; status: TaskGraphNodeStatus; taskId?: string; failureReason?: string; verificationDisposition?: TaskGraphVerificationDisposition }>
export type TaskGraphState = Readonly<{ revision: number; nodes: readonly TaskGraphNode[]; appliedEvents: readonly TaskGraphEvent[]; repairSatisfiedNodeKeys?: readonly string[]; repairPendingNodeKeys?: readonly string[] }>
export type TaskGraphValidationOptions = Readonly<{ registeredTemplateIds: ReadonlySet<string>; maxNodes: number; maxDepth: number }>
/** Hard persisted-shape limits shared by model validation and snapshot parsing. */
export const TASK_GRAPH_LIMITS = {
  maxProposalBytes: 32_000,
  maxSnapshotBytes: 40_000,
  maxNodes: 8,
  maxDepth: 8,
  maxKeyLength: 128,
  maxTemplateIdLength: 128,
  maxGoalLength: 1200,
  maxSuccessCriteria: 8,
  maxCriterionLength: 320,
  maxDependencies: 8,
} as const

export type TaskGraphEventType = "task.started" | "task.queued" | "task.waiting" | "task.waiting_for_user" | "task.retrying" | "task.completed" | "task.failed" | "task.interrupted" | "task.cancelled" | "task.closed"
type TaskGraphEventBase = Readonly<{ idempotencyKey: string; expectedRevision: number; nodeKey: string }>
export type TaskGraphEvent = TaskGraphEventBase & (Readonly<{ type: Exclude<TaskGraphEventType, "task.failed"> }> | Readonly<{ type: "task.failed"; failureReason: string }>)

export type TaskGraphErrorCode = "invalid_shape" | "invalid_options" | "invalid_state" | "revision_mismatch" | "empty_proposal" | "duplicate_key" | "unknown_template" | "missing_dependency" | "dependency_cycle" | "node_limit" | "depth_limit" | "node_not_found" | "invalid_transition" | "dependencies_incomplete" | "blocked_dependency" | "idempotency_conflict" | "verification_required" | "verification_invalid" | "unsupported_verification_template" | "repair_invalid"
export type TaskGraphError = Readonly<{ code: TaskGraphErrorCode; path: string; message: string }>
export type TaskGraphFailure = Readonly<{ ok: false; error: TaskGraphError }>
export type TaskGraphValidationResult = TaskGraphFailure | Readonly<{ ok: true; proposal: TaskGraphProposal; addedNodes: readonly TaskGraphNode[] }>
export type TaskGraphAppendResult = TaskGraphFailure | Readonly<{ ok: true; state: TaskGraphState; addedNodes: readonly TaskGraphNode[] }>
export type TaskGraphTransitionResult = TaskGraphFailure | Readonly<{ ok: true; state: TaskGraphState; duplicate: boolean }>
export type TaskGraphReadiness = "ready" | "waiting_for_dependencies" | "blocked_dependency" | "active" | "terminal"
export type TaskGraphReadNode = TaskGraphNode & Readonly<{ readiness: TaskGraphReadiness }>

const NODE_KEYS = "dependsOn,goal,key,successCriteria,templateId"
const NODE_KEYS_WITH_VERIFICATION = `${NODE_KEYS},verification`
const NODE_KEYS_WITH_REPAIR = "dependsOn,goal,key,repairOf,successCriteria,templateId,verification"
const TERMINAL = new Set<TaskGraphNodeStatus>(["completed", "failed", "interrupted", "cancelled", "closed"])
const BLOCKING = new Set<TaskGraphNodeStatus>(["failed", "interrupted", "cancelled", "closed"])
const ACTIVE_FROM: Readonly<Record<TaskGraphEventType, readonly TaskGraphNodeStatus[]>> = {
  "task.started": ["queued", "retrying", "waiting", "waiting_for_user"],
  "task.queued": ["waiting"],
  "task.waiting": ["running"], "task.waiting_for_user": ["running"], "task.retrying": ["running"],
  "task.completed": ["running"], "task.failed": ["running"],
  "task.interrupted": ["queued", "running", "retrying", "waiting", "waiting_for_user"],
  "task.cancelled": ["queued", "running", "retrying", "waiting", "waiting_for_user"],
  "task.closed": ["queued", "running", "retrying", "waiting", "waiting_for_user"],
}
const NEXT_STATUS: Readonly<Record<TaskGraphEventType, TaskGraphNodeStatus>> = {
  "task.started": "running", "task.queued": "queued", "task.waiting": "waiting", "task.waiting_for_user": "waiting_for_user",
  "task.retrying": "queued", "task.completed": "completed", "task.failed": "failed",
  "task.interrupted": "interrupted", "task.cancelled": "cancelled", "task.closed": "closed",
}

function fail(code: TaskGraphErrorCode, path: string, message: string): TaskGraphFailure {
  return { ok: false, error: { code, path, message } }
}
function plainRecord(value: unknown, keys: string): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).sort().join(",") === keys
}
function text(value: unknown, maxLength = Number.MAX_SAFE_INTEGER): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
}
function integer(value: unknown, minimum: number): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }
function textArray(value: unknown, allowEmpty: boolean, maxItems: number, maxLength: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return false
  for (const key of keys) {
    if (key === "length") continue
    if (typeof key !== "string") return false
    const index = Number(key)
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key || !text(value[index], maxLength)) return false
  }
  return true
}
function parseRepairOf(value: unknown, index: number): TaskGraphRepairOf | TaskGraphFailure {
  const path = `nodes[${index}].repairOf`
  if (!plainRecord(value, "criterionIds,graphRootTaskId,nodeKey,taskId") || !text(value.graphRootTaskId, 128)
    || !text(value.nodeKey, TASK_GRAPH_LIMITS.maxKeyLength) || !text(value.taskId, TASK_GRAPH_LIMITS.maxKeyLength)
    || !textArray(value.criterionIds, false, TASK_GRAPH_LIMITS.maxSuccessCriteria, 64)
    || new Set(value.criterionIds).size !== value.criterionIds.length) return fail("invalid_shape", path, "repairOf must name a root, prior node, task, and unique criteria")
  return { graphRootTaskId: value.graphRootTaskId, nodeKey: value.nodeKey, taskId: value.taskId, criterionIds: [...value.criterionIds] }
}
function parseNode(value: unknown, index: number): TaskGraphNodeProposal | TaskGraphFailure {
  const path = `nodes[${index}]`
  if (!plainRecord(value, NODE_KEYS) && !plainRecord(value, NODE_KEYS_WITH_VERIFICATION) && !plainRecord(value, NODE_KEYS_WITH_REPAIR)) return fail("invalid_shape", path, "Node must contain the exact TaskGraph fields and optional typed verification or repair relation")
  if (!text(value.key, TASK_GRAPH_LIMITS.maxKeyLength) || !text(value.templateId, TASK_GRAPH_LIMITS.maxTemplateIdLength)
    || !text(value.goal, TASK_GRAPH_LIMITS.maxGoalLength)) return fail("invalid_shape", path, "key, templateId, and goal must be non-empty and within their length limits")
  if (!textArray(value.successCriteria, false, TASK_GRAPH_LIMITS.maxSuccessCriteria, TASK_GRAPH_LIMITS.maxCriterionLength)) return fail("invalid_shape", `${path}.successCriteria`, "Success criteria must contain one to eight non-empty strings of at most 320 characters")
  if (!textArray(value.dependsOn, true, TASK_GRAPH_LIMITS.maxDependencies, TASK_GRAPH_LIMITS.maxKeyLength)) return fail("invalid_shape", `${path}.dependsOn`, "dependsOn must contain at most eight non-empty local keys of at most 128 characters")
  if (new Set(value.dependsOn).size !== value.dependsOn.length) return fail("invalid_shape", `${path}.dependsOn`, "Dependencies must be unique")
  const node = value as Record<string, unknown>
  let repairOf: TaskGraphRepairOf | undefined
  if (Object.hasOwn(node, "repairOf")) { const parsed = parseRepairOf(node.repairOf, index); if ("ok" in parsed) return parsed; repairOf = parsed }
  return { key: value.key as string, templateId: value.templateId as string, goal: value.goal as string, successCriteria: [...value.successCriteria] as string[], dependsOn: [...value.dependsOn] as string[], ...(Object.hasOwn(node, "verification") ? { verification: node.verification as TaskGraphVerificationContract } : {}), ...(repairOf ? { repairOf } : {}) }
}
export function isValidTaskGraphRepairRelation(node: TaskGraphNodeProposal, target: TaskGraphNodeProposal & Readonly<{ taskId?: string; verificationDisposition?: TaskGraphVerificationDisposition }>): boolean {
  const relation = node.repairOf, role = taskGraphVerificationRole(node.templateId)
  const targetContract = validateTaskGraphVerificationContract(target.verification, target.templateId)
  const repairContract = validateTaskGraphVerificationContract(node.verification, node.templateId)
  if (!relation || !role || node.templateId !== target.templateId || relation.nodeKey !== target.key || relation.taskId !== target.taskId
    || !relation.graphRootTaskId.trim() || target.verificationDisposition === "legacy_unverified" || target.verificationDisposition === "specialized"
    || node.dependsOn.includes(target.key) || !targetContract.ok || !repairContract.ok
    || new Set(relation.criterionIds).size !== relation.criterionIds.length || repairContract.contract.criteria.length !== relation.criterionIds.length) return false
  const criteria = new Map(targetContract.contract.criteria.map(item => [item.id, item.check] as const))
  return relation.criterionIds.every(id => criteria.has(id)) && repairContract.contract.criteria.every(item => relation.criterionIds.includes(item.id) && JSON.stringify(item.check) === JSON.stringify(criteria.get(item.id)))
}
function validateNodeVerification(node: TaskGraphNodeProposal, index: number, state: TaskGraphState): TaskGraphNodeProposal | TaskGraphFailure {
  const supported = taskGraphVerificationRole(node.templateId) !== undefined
  if (node.repairOf && !supported) return fail("repair_invalid", `nodes[${index}].repairOf`, "Only typed Scout and Analyst nodes can repair criteria")
  if (!supported && node.verification === undefined) return node
  if (node.verification === undefined) return fail("verification_required", `nodes[${index}].verification`, "Scout and Analyst nodes require typed verification criteria")
  const result = validateTaskGraphVerificationContract(node.verification, node.templateId)
  if (!result.ok) return fail(result.error.code === "unsupported_template" ? "unsupported_verification_template" : "verification_invalid", `nodes[${index}].${result.error.path}`, "Typed verification contract is not valid for the registered template")
  if (node.repairOf) { const target = state.nodes.find(item => item.key === node.repairOf!.nodeKey); if (!target || !isValidTaskGraphRepairRelation(node, target)) return fail("repair_invalid", `nodes[${index}].repairOf`, "Repair must match criteria on an existing typed node without adding a dependency edge") }
  return { ...node, verification: result.contract }
}

export function createInitialTaskGraphState(): TaskGraphState {
  return { revision: 0, nodes: [], appliedEvents: [] }
}

export function validateTaskGraphProposal(value: unknown, state: TaskGraphState, options: TaskGraphValidationOptions): TaskGraphValidationResult {
  if (!integer(state?.revision, 0) || !Array.isArray(state.nodes) || !Array.isArray(state.appliedEvents)) return fail("invalid_state", "state", "TaskGraph state is malformed")
  if (!options || typeof options.registeredTemplateIds?.has !== "function" || !integer(options.maxNodes, 1) || !integer(options.maxDepth, 1)) return fail("invalid_options", "options", "Registered templates and positive node/depth limits are required")
  const maxNodes = Math.min(options.maxNodes, TASK_GRAPH_LIMITS.maxNodes)
  const maxDepth = Math.min(options.maxDepth, TASK_GRAPH_LIMITS.maxDepth)
  if (!plainRecord(value, "expectedRevision,nodes") || !integer(value.expectedRevision, 0) || !Array.isArray(value.nodes)) return fail("invalid_shape", "proposal", "Proposal must contain exactly expectedRevision and nodes")
  if (value.expectedRevision !== state.revision) return fail("revision_mismatch", "expectedRevision", "Proposal revision is stale")
  if (value.nodes.length === 0) return fail("empty_proposal", "nodes", "Proposal must append at least one node")
  if (state.nodes.length + value.nodes.length > maxNodes) return fail("node_limit", "nodes", "TaskGraph node limit exceeded")
  const nodes: TaskGraphNodeProposal[] = []
  const keys = new Set(state.nodes.map(node => node.key))
  for (let index = 0; index < value.nodes.length; index++) {
    const parsed = parseNode(value.nodes[index], index)
    if ("ok" in parsed) return parsed
    if (keys.has(parsed.key)) return fail("duplicate_key", `nodes[${index}].key`, "Node keys must be unique across the graph")
    if (!options.registeredTemplateIds.has(parsed.templateId)) return fail("unknown_template", `nodes[${index}].templateId`, "Template ID is not registered")
    const verified = validateNodeVerification(parsed, index, state)
    if ("ok" in verified) return verified
    keys.add(verified.key); nodes.push(verified)
  }
  const all: readonly (TaskGraphNode | TaskGraphNodeProposal)[] = [...state.nodes, ...nodes]
  const byKey = new Map<string, TaskGraphNode | TaskGraphNodeProposal>(all.map(node => [node.key, node] as const))
  const indegree = new Map<string, number>(all.map(node => [node.key, 0] as const))
  const children = new Map<string, string[]>(all.map(node => [node.key, []] as const))
  for (const node of all) for (const dependency of node.dependsOn) {
    if (!byKey.has(dependency)) return fail("missing_dependency", `nodes.${node.key}.dependsOn`, `Unknown local dependency: ${dependency}`)
    indegree.set(node.key, indegree.get(node.key)! + 1); children.get(dependency)!.push(node.key)
  }
  const depths = new Map<string, number>()
  const queue = all.filter(node => indegree.get(node.key) === 0).map(node => node.key)
  let processed = 0
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const key = queue[cursor]!, node = byKey.get(key)!, depth = node.dependsOn.reduce<number>((maximum, dependency) => Math.max(maximum, depths.get(dependency) ?? 0), 0) + 1
    depths.set(key, depth); processed++
     if (depth > maxDepth) return fail("depth_limit", `nodes.${key}`, "TaskGraph depth limit exceeded")
    for (const child of children.get(key)!) {
      indegree.set(child, indegree.get(child)! - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  if (processed !== all.length) return fail("dependency_cycle", "nodes", "Dependencies must form a directed acyclic graph")
  const proposal: TaskGraphProposal = { expectedRevision: value.expectedRevision, nodes }
  const addedNodes = nodes.map(node => ({
    ...node, depth: depths.get(node.key)!, status: "queued" as const,
  }))
  return { ok: true, proposal, addedNodes }
}

export function appendTaskGraphProposal(state: TaskGraphState, value: unknown, options: TaskGraphValidationOptions): TaskGraphAppendResult {
  const validation = validateTaskGraphProposal(value, state, options)
  if (!validation.ok) return validation
  return { ok: true, state: { revision: state.revision + 1, nodes: [...state.nodes, ...validation.addedNodes], appliedEvents: state.appliedEvents, repairSatisfiedNodeKeys: state.repairSatisfiedNodeKeys, repairPendingNodeKeys: state.repairPendingNodeKeys }, addedNodes: validation.addedNodes }
}

function blockedByDependency(node: TaskGraphNode, byKey: ReadonlyMap<string, TaskGraphNode>, memo: Map<string, boolean>, repaired: ReadonlySet<string>, pending: ReadonlySet<string>): boolean {
  const known = memo.get(node.key)
  if (known !== undefined) return known
  const blocked = node.dependsOn.some(key => {
    const dependency = byKey.get(key)
    return !dependency || ((BLOCKING.has(dependency.status) && !repaired.has(key) && !pending.has(key))
      || blockedByDependency(dependency, byKey, memo, repaired, pending))
  })
  memo.set(node.key, blocked); return blocked
}
export function deriveTaskGraphReadModel(state: TaskGraphState): readonly TaskGraphReadNode[] {
  const byKey = new Map<string, TaskGraphNode>(state.nodes.map(node => [node.key, node] as const)), blocked = new Map<string, boolean>(), repaired = new Set(state.repairSatisfiedNodeKeys ?? []), pending = new Set(state.repairPendingNodeKeys ?? [])
  return state.nodes.map(node => {
    let readiness: TaskGraphReadiness
    if (node.status === "queued" || node.status === "waiting") {
      if (blockedByDependency(node, byKey, blocked, repaired, pending)) readiness = "blocked_dependency"
      else readiness = node.dependsOn.every(key => byKey.get(key)?.status === "completed" || repaired.has(key)) ? "ready" : "waiting_for_dependencies"
    }
    else readiness = TERMINAL.has(node.status) ? "terminal" : "active"
    return { ...node, readiness }
  })
}
export function deriveReadyTaskGraphNodes(state: TaskGraphState): readonly TaskGraphNode[] {
  return deriveTaskGraphReadModel(state).filter(node => node.status === "queued" && node.readiness === "ready")
}
function parseEvent(value: unknown): TaskGraphEvent | TaskGraphFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_shape", "event", "Event must be an object")
  const row = value as Record<string, unknown>
  if (!text(row.type) || !text(row.idempotencyKey) || !text(row.nodeKey) || !integer(row.expectedRevision, 0)) return fail("invalid_shape", "event", "Event identity, node key, and revision are required")
  const type = row.type as TaskGraphEventType
  if (!Object.hasOwn(ACTIVE_FROM, type)) return fail("invalid_shape", "event.type", "Unsupported task event")
  const keys = type === "task.failed" ? "expectedRevision,failureReason,idempotencyKey,nodeKey,type" : "expectedRevision,idempotencyKey,nodeKey,type"
  if (!plainRecord(value, keys) || (type === "task.failed" && !text(row.failureReason))) return fail("invalid_shape", "event", "Event has an invalid exact shape")
  return type === "task.failed"
    ? { type, idempotencyKey: row.idempotencyKey as string, expectedRevision: row.expectedRevision as number, nodeKey: row.nodeKey as string, failureReason: row.failureReason as string }
    : { type, idempotencyKey: row.idempotencyKey as string, expectedRevision: row.expectedRevision as number, nodeKey: row.nodeKey as string }
}
function sameEvent(left: TaskGraphEvent, right: TaskGraphEvent): boolean {
  return left.type === right.type && left.idempotencyKey === right.idempotencyKey && left.expectedRevision === right.expectedRevision
    && left.nodeKey === right.nodeKey && (left.type !== "task.failed" || (right.type === "task.failed" && left.failureReason === right.failureReason))
}
export function reduceTaskGraphEvent(state: TaskGraphState, value: unknown): TaskGraphTransitionResult {
  const event = parseEvent(value)
  if ("ok" in event) return event
  const previous = state.appliedEvents.find(applied => applied.idempotencyKey === event.idempotencyKey)
  if (previous) return sameEvent(previous, event) ? { ok: true, state, duplicate: true } : fail("idempotency_conflict", "event.idempotencyKey", "Idempotency key was already used for a different event")
  if (event.expectedRevision !== state.revision) return fail("revision_mismatch", "event.expectedRevision", "Event revision is stale")
  const node = state.nodes.find(item => item.key === event.nodeKey)
  if (!node) return fail("node_not_found", "event.nodeKey", "TaskGraph node does not exist")
  if (!ACTIVE_FROM[event.type].includes(node.status)) return fail("invalid_transition", "event.type", `Cannot apply ${event.type} to ${node.status}`)
  if (event.type === "task.started" || event.type === "task.queued") {
    const byKey = new Map<string, TaskGraphNode>(state.nodes.map(item => [item.key, item] as const)), repaired = new Set(state.repairSatisfiedNodeKeys ?? []), pending = new Set(state.repairPendingNodeKeys ?? [])
    if (blockedByDependency(node, byKey, new Map(), repaired, pending)) return fail("blocked_dependency", "event.nodeKey", "A blocking dependency prevents this node from becoming ready")
    if (!node.dependsOn.every(key => byKey.get(key)?.status === "completed" || repaired.has(key))) return fail("dependencies_incomplete", "event.nodeKey", "All dependencies must be completed before a node can be queued or started")
  }
  const updated = state.nodes.map(item => item.key !== node.key ? item : {
    ...item, status: NEXT_STATUS[event.type], ...(event.type === "task.failed" ? { failureReason: event.failureReason } : {}),
  })
  return { ok: true, state: { revision: state.revision + 1, nodes: updated, appliedEvents: [...state.appliedEvents, event], repairSatisfiedNodeKeys: state.repairSatisfiedNodeKeys, repairPendingNodeKeys: state.repairPendingNodeKeys }, duplicate: false }
}
