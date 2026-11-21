import type pg from "pg"
import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"
import { TASK_GRAPH_VERIFICATION_LIMITS } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { RootTaskVerificationRequirement, RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import { verifyTaskGraphRetainedScoutLocationProof } from "./task-graph-retained-scout-location-proof.js"
import type { GraphIdentityScope, GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { taskGraphItemId, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { validateRoleResult } from "./role-results.js"

const LOCATION_REQUIREMENT_ID = "candidate-location"
const MAX_PG_BIGINT = (1n << 63n) - 1n
type Client = Pick<pg.PoolClient, "query">
type ValidRequirements = Extract<RootTaskVerificationRequirementsResolution, { status: "valid" }>

export type TaskGraphCurrentLocationEvidenceInput = Readonly<{
  client: Client
  loaded: LoadedGraph
  scope: GraphIdentityScope
  initialRequirements: RootTaskVerificationRequirementsResolution
  verifiedCurrentLocations: readonly string[]
  acceptedInputSequence: bigint
  retainCompatiblePriorScouts: boolean
  /** Plan-only partition; terminal completion never supplies pending Scouts. */
  pendingSupersededNodeKeys?: ReadonlySet<string>
}>
export type TaskGraphCurrentLocationEvidenceResult =
  | Readonly<{
    status: "available"
    effectiveRequirements: ValidRequirements
    compatibleRetainedNodeKeys: ReadonlySet<string>
    excludedHistoricalNodeKeys: ReadonlySet<string>
  }>
  | Readonly<{ status: "unavailable" }>

const UNAVAILABLE: TaskGraphCurrentLocationEvidenceResult = Object.freeze({ status: "unavailable" })

/** Combines trusted current location authority with only independently rebound compatible old Scouts. */
export async function resolveTaskGraphCurrentLocationEvidence(
  input: TaskGraphCurrentLocationEvidenceInput,
): Promise<TaskGraphCurrentLocationEvidenceResult> {
  try {
    if (!input || typeof input !== "object") return UNAVAILABLE
    const { client, loaded, scope } = input
    const requirements = effectiveRequirements(input.initialRequirements, input.verifiedCurrentLocations)
    if (!client || !loaded || !scopeValid(scope) || !requirements || typeof input.retainCompatiblePriorScouts !== "boolean"
      || !validSequence(input.acceptedInputSequence)) return UNAVAILABLE
    const nodes = ownedNodes(loaded, scope)
    if (!nodes) return UNAVAILABLE
    const pending = pendingScoutSet(input.pendingSupersededNodeKeys, nodes, loaded, input.acceptedInputSequence)
    if (!pending) return UNAVAILABLE

    const locationRequirement = requirements.requirements.find(item => item.kind === "candidate_location_in")
    if (!locationRequirement || locationRequirement.kind !== "candidate_location_in") return UNAVAILABLE
    const compatibleRetainedNodeKeys = new Set<string>(), excludedHistoricalNodeKeys = new Set<string>()
    for (const { node, task } of nodes) {
      if (pending.has(node.key)) continue
      if (!isScoutIdentity(node, task)) {
        if (looksLikeScout(node, task)) return UNAVAILABLE
        continue
      }
      const checkpoint = loaded.sourceInputCheckpointByNodeKey?.get(node.key)
      if (!validCheckpoint(checkpoint)) return UNAVAILABLE
      if (checkpoint.inputThroughSequence >= input.acceptedInputSequence) continue

      if (task.status !== "completed" || task.failureReason !== null || !Number.isSafeInteger(task.attemptCount)
        || task.attemptCount! < 1 || !ordinaryTypedScout(node) || !validHistoricalScoutBody(task.result)) return UNAVAILABLE
      if (!input.retainCompatiblePriorScouts) {
        excludedHistoricalNodeKeys.add(node.key)
        continue
      }
      const decision = await verifyTaskGraphRetainedScoutLocationProof({
        client, scope: { ...scope, taskId: task.id, attemptCount: task.attemptCount! },
        snapshot: loaded.snapshot!, node, task, requirement: locationRequirement,
      })
      if (decision.status === "compatible") compatibleRetainedNodeKeys.add(node.key)
      else excludedHistoricalNodeKeys.add(node.key)
    }
    return { status: "available", effectiveRequirements: requirements,
      compatibleRetainedNodeKeys, excludedHistoricalNodeKeys }
  } catch {
    return UNAVAILABLE
  }
}

function pendingScoutSet(
  value: ReadonlySet<string> | undefined,
  nodes: readonly { node: StoredTaskGraphNode; task: GraphTaskRow }[],
  loaded: LoadedGraph,
  acceptedSequence: bigint,
): ReadonlySet<string> | undefined {
  if (value === undefined) return new Set()
  if (!(value instanceof Set) || value.size > nodes.length) return undefined
  const result = new Set<string>()
  for (const key of value) {
    const source = nodes.find(item => item.node.key === key)
    const checkpoint = loaded.sourceInputCheckpointByNodeKey?.get(key)
    if (typeof key !== "string" || !source || !isScoutIdentity(source.node, source.task)
      || source.task.status !== "running" || source.task.failureReason !== null
      || !Number.isSafeInteger(source.task.attemptCount) || source.task.attemptCount! < 1
      || !ordinaryTypedScout(source.node) || !validCheckpoint(checkpoint)
      || checkpoint.inputThroughSequence >= acceptedSequence) return undefined
    result.add(key)
  }
  return result
}

function effectiveRequirements(
  initial: RootTaskVerificationRequirementsResolution,
  currentLocations: readonly string[],
): ValidRequirements | undefined {
  if (initial.status === "invalid" || !Array.isArray(currentLocations) || currentLocations.length < 1
    || currentLocations.length > 8 || Reflect.ownKeys(currentLocations).length !== currentLocations.length + 1) return undefined
  const canonical = normalizeAgentLocationAllowlist(currentLocations)
  if (!canonical || canonical.length !== currentLocations.length
    || canonical.some((location, index) => location !== currentLocations[index])) return undefined
  const original = initial.status === "valid" ? initial.requirements : []
  if (!Array.isArray(original) || original.length > TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria) return undefined
  const ids = new Set<string>(), output: RootTaskVerificationRequirement[] = []
  let locationIndex = -1
  for (let index = 0; index < original.length; index += 1) {
    const requirement = original[index]
    if (!requirement || !validRequirement(requirement) || ids.has(requirement.id)) return undefined
    ids.add(requirement.id)
    if (requirement.kind === "candidate_location_in") {
      if (requirement.id !== LOCATION_REQUIREMENT_ID || locationIndex >= 0) return undefined
      locationIndex = output.length
      output.push({ id: LOCATION_REQUIREMENT_ID, kind: requirement.kind, locations: canonical })
    } else output.push(requirement)
  }
  if (locationIndex < 0) {
    if (ids.has(LOCATION_REQUIREMENT_ID)) return undefined
    output.push({ id: LOCATION_REQUIREMENT_ID, kind: "candidate_location_in", locations: canonical })
  }
  if (output.length > TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria) return undefined
  return { status: "valid", requirements: output }
}

function validRequirement(value: RootTaskVerificationRequirement): boolean {
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(value.id)) return false
  if (value.kind === "candidate_location_in") {
    const locations = normalizeAgentLocationAllowlist(value.locations)
    return !!locations && locations.length === value.locations.length
      && locations.every((location, index) => location === value.locations[index])
  }
  return (value.kind === "candidate_count_gte" || value.kind === "finding_count_gte")
    && Number.isSafeInteger(value.minimum) && value.minimum >= 1
    && value.minimum <= TASK_GRAPH_VERIFICATION_LIMITS.maxItems
}

function ownedNodes(loaded: LoadedGraph, scope: GraphIdentityScope): Array<{ node: StoredTaskGraphNode; task: GraphTaskRow }> | undefined {
  if (loaded.rootTaskId !== scope.rootTaskId || scope.parentTaskId !== scope.rootTaskId) return undefined
  if (!loaded.item && !loaded.snapshot && !loaded.state && loaded.tasks.size === 0) return []
  const snapshot = loaded.snapshot, state = loaded.state, item = loaded.item
  if (!snapshot || !state || !item || item.id !== taskGraphItemId(scope.parentTaskId)
    || !Number.isSafeInteger(item.revision) || item.revision < 1 || state.revision !== item.revision
    || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > TASK_GRAPH_LIMITS.maxPersistedNodes
    || state.nodes.length !== snapshot.nodes.length || loaded.tasks.size !== snapshot.nodes.length) return undefined
  const result: Array<{ node: StoredTaskGraphNode; task: GraphTaskRow }> = []
  const nodeKeys = new Set<string>(), taskIds = new Set<string>()
  for (const [index, node] of snapshot.nodes.entries()) {
    const task = loaded.tasks.get(node.taskId), stateNode = state.nodes[index]
    if (!task || task.id !== node.taskId || !stateNode || stateNode.key !== node.key || stateNode.taskId !== node.taskId
      || stateNode.status !== task.status || (stateNode.failureReason ?? null) !== task.failureReason
      || nodeKeys.has(node.key) || taskIds.has(task.id)) return undefined
    nodeKeys.add(node.key)
    taskIds.add(task.id)
    result.push({ node, task })
  }
  return result
}

function looksLikeScout(node: StoredTaskGraphNode, task: GraphTaskRow): boolean {
  return node.templateId === "scout" || task.role === "scout" || task.taskType === "job_discovery"
}
function isScoutIdentity(node: StoredTaskGraphNode, task: GraphTaskRow): boolean {
  return node.templateId === "scout" && task.role === "scout" && task.taskType === "job_discovery"
}
function ordinaryTypedScout(node: StoredTaskGraphNode): boolean {
  return node.verificationDisposition === "typed" && node.verification?.role === "scout"
    && !node.repairOf && !node.nativeDelegation
}
function validHistoricalScoutBody(value: unknown): boolean {
  const envelope = record(value)
  if (!envelope || envelope.status !== "completed" || !Object.hasOwn(envelope, "structuredResult")) return false
  try { validateRoleResult(envelope.structuredResult, "scout"); return true } catch { return false }
}
function record(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}
function validCheckpoint(value: unknown): value is Readonly<{ inputThroughSequence: bigint }> {
  if (!value || typeof value !== "object") return false
  try {
    const keys = Reflect.ownKeys(value), descriptor = Object.getOwnPropertyDescriptor(value, "inputThroughSequence")
    const sequence = descriptor && "value" in descriptor ? descriptor.value : undefined
    return keys.length === 1 && keys[0] === "inputThroughSequence" && !!descriptor?.enumerable
      && typeof sequence === "bigint" && sequence >= 0n && sequence <= MAX_PG_BIGINT
  } catch { return false }
}
function validSequence(value: unknown): value is bigint {
  return typeof value === "bigint" && value > 0n && value <= MAX_PG_BIGINT
}
function scopeValid(scope: GraphIdentityScope): boolean {
  if (!scope || typeof scope !== "object") return false
  const ids = [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId]
  return ids.every(value => typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value))
    && scope.rootTaskId === scope.parentTaskId
}
