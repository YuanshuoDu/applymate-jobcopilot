import { Buffer } from "node:buffer"
import { TaskGraphCommandError } from "./task-graph-command-port.js"
import type { Queryable } from "./pg-store-persistence.js"
import { resolveRootTaskObjective } from "../context/root-task-objective.js"
import type { SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import type { TaskGraphSupersessionRelation } from "./task-graph-pg-supersession.js"

const MAX_ADDITIONAL_CRITERIA = 4
const MAX_ADDITIONAL_CRITERION_BYTES = 512
const MAX_ROOT_CRITERIA = 32
const MAX_ROOT_CRITERION_BYTES = 2_000

export type RootPlanCriteriaResolution = Readonly<{
  status: "unchanged" | "persist" | "conflict" | "invalid"
  criteria?: readonly string[]
}>

type RootPlanScope = Readonly<{ turnId: string; sessionId: string; userId: string; rootTaskId: string }>
type RootPlanOwner = Readonly<{ goal?: unknown; successCriteria?: unknown }>
export type SupersessionCallBinding = Readonly<{ replaceUnstartedNodeKey: string; replacementFingerprint?: string; source?: TaskGraphSupersessionRelation["source"]; replacementNode?: StoredTaskGraphNode; callId?: string; stepId?: string; operationKey?: string }>

type CallMatchDependencies = Readonly<{
  object: (value: unknown) => Record<string, unknown> | null
  validToolCall: typeof import("./steering-reconciliation-contract.js").validSteeringReconciliationToolCall
  normalizedProposalNode: (value: unknown, rootTaskId: string) => Record<string, unknown> | null
  fingerprint: typeof import("./task-graph-pg-supersession.js").taskGraphSupersessionFingerprint
  sameProposalNode: (proposal: Record<string, unknown>, stored: StoredTaskGraphNode) => boolean
}>

export function callMatches(
  row: Record<string, unknown>, scope: SteeringReconciliationScope, stepId: string, decision: "keep" | "revise", revision: number,
  binding: SupersessionCallBinding | undefined, dependencies: CallMatchDependencies,
): boolean {
  const matches = dependencies.validToolCall({ type: row.type, actor: row.actor, taskId: row.eventTaskId, itemId: row.eventItemId,
    correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, payload: row.payload },
  { id: row.callItemId, stepId: row.stepId, taskId: row.itemTaskId, type: row.itemType, content: row.itemContent }, scope, stepId, decision, revision,
  binding?.replaceUnstartedNodeKey)
  if (!matches || !binding?.replacementFingerprint) return matches
  const content = dependencies.object(row.itemContent), input = dependencies.object(content?.input)
  const node = input && Array.isArray(input.nodes) && input.nodes.length === 1
    ? dependencies.normalizedProposalNode(input.nodes[0], scope.rootTaskId) : null
  const hasRootSuccessCriteria = Boolean(input && Object.hasOwn(input, "rootSuccessCriteria"))
  const rootSuccessCriteria = hasRootSuccessCriteria ? normalizeRootPlanCriteria(input?.rootSuccessCriteria) : undefined
  if (rootSuccessCriteria === null || hasRootSuccessCriteria && rootSuccessCriteria === undefined) return false
  return Boolean(input && node && binding.source && dependencies.fingerprint(binding.source, {
    expectedRevision: revision, replaceUnstartedNodeKey: binding.replaceUnstartedNodeKey, nodes: [node],
    rootSuccessCriteria,
  }) === binding.replacementFingerprint && (binding.replacementNode === undefined || dependencies.sameProposalNode(node, binding.replacementNode)))
}

/** Normalizes only outer whitespace; the accepted wording remains otherwise unchanged. */
export function normalizeRootPlanCriteria(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  const items = ownDataArray(value, MAX_ADDITIONAL_CRITERIA)
  if (!items?.length) return null
  const criteria: string[] = []
  for (const raw of items) {
    if (typeof raw !== "string") return null
    const item = raw.trim()
    if (!item || Buffer.byteLength(item, "utf8") > MAX_ADDITIONAL_CRITERION_BYTES) return null
    if (!criteria.includes(item)) criteria.push(item)
  }
  return criteria
}

export function requireNormalizedRootPlanCriteria(value: unknown): readonly string[] | undefined {
  const criteria = normalizeRootPlanCriteria(value)
  if (criteria === null) throw new TaskGraphCommandError("root_success_criteria_invalid", "Additional root criteria are invalid")
  return criteria
}

/** Parses the server-owned JSONB checklist, including the empty legacy value. */
export function parsePersistedRootCriteria(value: unknown): readonly string[] | null {
  const items = ownDataArray(value, MAX_ROOT_CRITERIA)
  if (!items) return null
  const criteria: string[] = []
  for (const item of items) {
    if (typeof item !== "string" || !item || item.trim() !== item
      || Buffer.byteLength(item, "utf8") > MAX_ROOT_CRITERION_BYTES || criteria.includes(item)) return null
    criteria.push(item)
  }
  return criteria
}

function ownDataArray(value: unknown, maximum: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) return null
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    const items: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const item = descriptors[String(index)]
      if (!item || !("value" in item) || !item.enumerable) return null
      items.push(item.value)
    }
    return items
  } catch { return null }
}
export function parsePinnedRootCriteria(value: unknown): readonly string[] | null {
  const criteria = parsePersistedRootCriteria(value)
  return !criteria || criteria.length < 1 || criteria.length > MAX_ADDITIONAL_CRITERIA + 1
    || criteria.slice(1).some(item => Buffer.byteLength(item, "utf8") > MAX_ADDITIONAL_CRITERION_BYTES) ? null : criteria
}

export function readRootPlanCriteriaObservation(state: Record<string, unknown>): readonly string[] | undefined {
  return readRootCriteriaProperty(state, parsePersistedRootCriteria, "task_graph_current_state_invalid:rootSuccessCriteria")
}

export function resolveRootPlanCriteriaReadback(
  goal: unknown, rootCriteriaValue: unknown, pinnedValue: unknown,
): Readonly<{ valid: boolean; criteria?: readonly string[] }> {
  const rootCriteria = parsePersistedRootCriteria(rootCriteriaValue)
  const pinned = pinnedValue === undefined ? undefined : parsePinnedRootCriteria(pinnedValue)
  if (!rootCriteria || pinnedValue !== undefined && !pinned
    || pinned && (typeof goal !== "string" || goal.trim() !== pinned[0])) return { valid: false }
  const criteria = pinned ?? (rootCriteria.length ? rootCriteria : undefined)
  return { valid: true, ...(criteria ? { criteria } : {}) }
}

export function requireRootPlanCriteriaReadback(goal: unknown, rootCriteriaValue: unknown, pinnedValue: unknown): readonly string[] | undefined {
  const result = resolveRootPlanCriteriaReadback(goal, rootCriteriaValue, pinnedValue)
  if (!result.valid) throw new TaskGraphCommandError("root_success_criteria_invalid", "Persisted root criteria do not match the owned objective")
  return result.criteria
}

export function readPinnedRootCriteria(state: Record<string, unknown>): readonly string[] | undefined {
  return readRootCriteriaProperty(state, parsePinnedRootCriteria, "task_graph_snapshot_root_criteria_invalid")
}

function readRootCriteriaProperty(
  state: Record<string, unknown>, parse: (value: unknown) => readonly string[] | null, errorCode: string,
): readonly string[] | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(state, "rootSuccessCriteria")
    if (!descriptor) return undefined
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(errorCode)
    const criteria = parse(descriptor.value)
    if (!criteria) throw new Error(errorCode)
    return criteria
  } catch { throw new Error(errorCode) }
}

/** Pins the immutable server goal before model-authored additional requirements. */
export function resolveRootPlanCriteria(
  goal: unknown, currentValue: unknown, additional: readonly string[], ownedCriteriaValue: unknown = [],
): RootPlanCriteriaResolution {
  if (typeof goal !== "string" || !goal.trim() || goal.trim() !== goal
    || Buffer.byteLength(goal, "utf8") > MAX_ROOT_CRITERION_BYTES) return { status: "invalid" }
  const current = parsePersistedRootCriteria(currentValue)
  const ownedCriteria = parsePersistedRootCriteria(ownedCriteriaValue)
  if (!current || !ownedCriteria) return { status: "invalid" }
  const pinnedAdditional = current.length ? current.slice(1) : additional
  const verifierCriteria = [...new Set([goal, ...ownedCriteria, ...pinnedAdditional])]
  if (verifierCriteria.length > MAX_ROOT_CRITERIA
    || verifierCriteria.some(item => Buffer.byteLength(item, "utf8") > MAX_ROOT_CRITERION_BYTES)) return { status: "invalid" }
  const criteria = [...new Set([goal, ...additional])]
  if (criteria.length > MAX_ROOT_CRITERIA || criteria.some(item => Buffer.byteLength(item, "utf8") > MAX_ROOT_CRITERION_BYTES)) return { status: "invalid" }
  if (current.length === 0) return { status: "persist", criteria }
  return current.length === criteria.length && current.every((item, index) => item === criteria[index])
    ? { status: "unchanged", criteria }
    : { status: "conflict" }
}

/** Resolves a new or existing pin against the server-owned Turn and Root rows. */
export async function resolveOwnedRootPlanCriteria(
  client: Queryable, scope: RootPlanScope, root: RootPlanOwner,
  currentValue: readonly string[] | undefined, additional: readonly string[] | undefined,
): Promise<RootPlanCriteriaResolution> {
  const turn = await client.query<Record<string, unknown>>(`SELECT "input" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4 AND "status" = 'in_progress' FOR UPDATE`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  const objective = resolveRootTaskObjective(turn.rows[0]?.input, root)
  if (!objective.goal || objective.turnGoalConflict || !objective.criteriaValid) return { status: "invalid" }
  return resolveRootPlanCriteria(root.goal, currentValue ?? [], additional ?? currentValue?.slice(1) ?? [], objective.criteria)
}

export async function requireOwnedRootPlanCriteria(
  client: Queryable, scope: RootPlanScope, root: RootPlanOwner,
  currentValue: readonly string[] | undefined, additional: readonly string[] | undefined,
): Promise<readonly string[]> {
  const resolved = await resolveOwnedRootPlanCriteria(client, scope, root, currentValue, additional)
  if (resolved.status === "invalid") throw new TaskGraphCommandError("root_success_criteria_invalid", "The owned root objective or criteria are invalid")
  if (resolved.status === "conflict") throw new TaskGraphCommandError("root_success_criteria_conflict", "The root acceptance criteria are already pinned")
  return resolved.criteria!
}
