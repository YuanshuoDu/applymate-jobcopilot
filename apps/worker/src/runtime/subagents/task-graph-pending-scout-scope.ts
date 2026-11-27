import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"
import type { TaskGraphObjectiveLineageNode } from "../planning/task-graph-objective-lineage.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { validateTaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import type { TaskGraphConfirmedLocationSteerResult } from "./task-graph-confirmed-location-steer.js"
import { NESTED_SCOUT_PROFILE_MARKER, templatesForInteractiveScoutDelegation } from "./nested-scout-profile.js"
import type { TaskGraphExecutionScope, TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphItemId, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { parseRegisteredScoutEnvelope } from "./task-graph-command-port.js"
import type { PreparedSteeringReconciliation, SteeringReconciliationState } from "./steering-reconciliation-contract.js"

type ConfirmedSteer = Extract<TaskGraphConfirmedLocationSteerResult, { kind: "confirmed" }>
type PersistedGraphNodes = NonNullable<ReturnType<typeof graphNodes>>
type PendingScopeInput = Readonly<{
  loaded: LoadedGraph
  scope: TaskGraphExecutionScope
  reconciliation: SteeringReconciliationState
  prepared: PreparedSteeringReconciliation
  confirmed: ConfirmedSteer
  expectedRevision: number
  nodes: readonly TaskGraphObjectiveLineageNode[]
}>
export type PendingScoutScopeResult = Readonly<{ status: "available"; pendingNodeKeys: ReadonlySet<string> }>
  | Readonly<{ status: "unavailable" }>

const UNAVAILABLE: PendingScoutScopeResult = Object.freeze({ status: "unavailable" })
const MAX_SEQUENCE = (1n << 63n) - 1n
const REMOTE_SELECTORS = new Set(["remote", "anywhere", "worldwide", "work from home", "wfh", "distributed"])
const REGISTERED_SCOUT_TEMPLATES = [TASK_GRAPH_TEMPLATES.scout,
  templatesForInteractiveScoutDelegation(TASK_GRAPH_TEMPLATES, TASK_GRAPH_TEMPLATES)?.scout]
  .filter((template): template is TaskGraphTaskTemplate => Boolean(template))
/** Selects old active registered Scout work only for this exact confirmed location revise. */
export function classifyPendingSupersededScouts(input: PendingScopeInput): PendingScoutScopeResult {
  try {
    if (!input || typeof input !== "object" || !validAuthority(input)) return UNAVAILABLE
    const graph = graphNodes(input.loaded, input.scope)
    if (!graph) return UNAVAILABLE
    const currentLocations = canonicalLocations(input.confirmed.locations)
    if (!currentLocations) return UNAVAILABLE
    const lineage = validateLineage(input.nodes, graph)
    if (!lineage) return UNAVAILABLE
    const pendingNodeKeys = new Set<string>()
    for (const { node, task, checkpoint } of graph) {
      const stale = checkpoint < input.confirmed.acceptedInputSequence
      if (!stale || task.status !== "running" || !looksLikeScout(node, task)) continue
      if (!ordinaryRunningScout(node, task) || !validOldLocation(node)) return UNAVAILABLE
      const check = node.verification!.criteria.find(item => item.id === "candidate-location")?.check
      if (!check || check.kind !== "candidate_location_in") return UNAVAILABLE
      const oldLocations = canonicalLocations(check.locations)
      if (!oldLocations) return UNAVAILABLE
      if (oldLocations.some(location => currentLocations.includes(location))) continue
      pendingNodeKeys.add(node.key)
    }
    if (pendingNodeKeys.size === 0) return { status: "available", pendingNodeKeys }
    if (!hasFreshCurrentScout(lineage.added, currentLocations)
      || hasPendingLineageReference(lineage.nodes, pendingNodeKeys)) return UNAVAILABLE
    return { status: "available", pendingNodeKeys }
  } catch { return UNAVAILABLE }
}

function validAuthority(input: PendingScopeInput): boolean {
  const { scope, loaded, reconciliation: state, prepared, confirmed } = input
  const revision = loaded?.item?.revision ?? 0
  if (!scopeValid(scope) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== revision
    || !Number.isSafeInteger(revision) || revision < 0 || revision >= 2_147_483_646
    || prepared?.decision !== "revise" || prepared.expectedRevision !== revision || prepared.resultingRevision !== revision + 1
    || !sameScope(prepared.scope, scope) || prepared.inputThroughSequence <= 0n || prepared.inputThroughSequence > MAX_SEQUENCE
    || confirmed?.kind !== "confirmed" || typeof confirmed.acceptedInputSequence !== "bigint"
    || !validId(confirmed.acceptedInputId)
    || confirmed.acceptedInputSequence <= 0n || confirmed.acceptedInputSequence > prepared.inputThroughSequence
    || !state || state.currentRevision !== revision || state.agendaPlanRevision !== revision
    || state.decisionStepId !== scope.stepId || state.decisionStepAttempt !== 1
    || state.decisionInputThroughSequence !== prepared.inputThroughSequence
    || loaded.currentInputCheckpoint?.inputThroughSequence !== prepared.inputThroughSequence
    || state.lastReconciledInputThroughSequence !== undefined
      && state.lastReconciledInputThroughSequence >= confirmed.acceptedInputSequence
    || state.latestUserRevision !== undefined
      && (state.latestUserRevision.inputThroughSequence >= confirmed.acceptedInputSequence
        || state.latestUserRevision.resultingRevision > revision)) return false
  const pending = state.unresolvedInputs.length === 1 ? state.unresolvedInputs[0] : undefined
  return prepared.steerInputIds.length === 1 && pending?.status === "consumed"
    && pending.consumedByStepId === scope.stepId && pending.acceptedSequence === confirmed.acceptedInputSequence
    && pending.id === prepared.steerInputIds[0] && pending.id === confirmed.acceptedInputId
}

function graphNodes(loaded: LoadedGraph, scope: TaskGraphExecutionScope): Array<{
  node: StoredTaskGraphNode; task: GraphTaskRow; checkpoint: bigint
}> | undefined {
  if (!loaded || loaded.rootTaskId !== scope.rootTaskId || !loaded.sourceInputCheckpointByNodeKey) return undefined
  if (!loaded.item && !loaded.snapshot && !loaded.state) {
    return loaded.tasks.size === 0 && loaded.sourceInputCheckpointByNodeKey.size === 0 ? [] : undefined
  }
  const { item, snapshot, state } = loaded
  if (!item || !snapshot || !state || item.id !== taskGraphItemId(scope.rootTaskId)
    || item.revision !== state.revision || !Array.isArray(snapshot.nodes)
    || snapshot.nodes.length > TASK_GRAPH_LIMITS.maxPersistedNodes || state.nodes.length !== snapshot.nodes.length
    || loaded.tasks.size !== snapshot.nodes.length || loaded.sourceInputCheckpointByNodeKey.size !== snapshot.nodes.length) return undefined
  const keys = new Set<string>(), taskIds = new Set<string>(), result: Array<{ node: StoredTaskGraphNode; task: GraphTaskRow; checkpoint: bigint }> = []
  for (const [index, node] of snapshot.nodes.entries()) {
    const task = loaded.tasks.get(node.taskId), status = state.nodes[index], source = loaded.sourceInputCheckpointByNodeKey.get(node.key)
    if (!task || !status || status.key !== node.key || status.taskId !== node.taskId || status.status !== task.status
      || (status.failureReason ?? null) !== task.failureReason || task.id !== node.taskId || keys.has(node.key) || taskIds.has(task.id)
      || !source || typeof source.inputThroughSequence !== "bigint" || source.inputThroughSequence < 0n
      || source.inputThroughSequence > MAX_SEQUENCE) return undefined
    keys.add(node.key); taskIds.add(task.id)
    result.push({ node, task, checkpoint: source.inputThroughSequence })
  }
  return result
}

function ordinaryRunningScout(node: StoredTaskGraphNode, task: GraphTaskRow): boolean {
  return task.status === "running" && Number.isSafeInteger(task.attemptCount) && task.attemptCount! > 0
    && isOrdinaryRegisteredScout(node, task)
}

/** Exact registered Scout shape shared by planning and the private retirement proof. */
export function isOrdinaryRegisteredScout(node: StoredTaskGraphNode, task: GraphTaskRow): boolean {
  const envelope = parseRegisteredScoutEnvelope(node.registeredScoutEnvelope)
  const contract = node.verification && validateTaskGraphVerificationContract(node.verification, "scout")
  return node.templateId === "scout" && node.verificationDisposition === "typed" && !node.repairOf && !node.nativeDelegation
    && node.dependsOn.length === 0 && task.role === "scout" && task.taskType === "job_discovery"
    && task.failureReason === null
    && task.contextIsObject === true && task.hasPrivateSelectionContext === false
    && REGISTERED_SCOUT_TEMPLATES.some(template => registeredScoutProfileMatches(template, envelope, task))
    && contract?.ok === true && contract.contract.role === "scout"
}

function registeredScoutProfileMatches(template: TaskGraphTaskTemplate, envelope: unknown, task: GraphTaskRow): boolean {
  const nested = typeof template.context === "object" && template.context !== null
    && !Array.isArray(template.context) && "nestedScoutProfile" in template.context
  const contextMatches = nested ? task.contextIsCanonicalNestedScoutProfile === true && task.contextIsEmpty === false
    : task.contextIsCanonicalNestedScoutProfile === false && task.contextIsEmpty === true
  const expectedEnvelope = { role: template.role, taskType: template.taskType,
    expectedOutputSchema: template.expectedOutputSchema, allowedActions: template.allowedActions }
  if (nested && (template.context as Record<string, unknown>).nestedScoutProfile !== NESTED_SCOUT_PROFILE_MARKER) return false
  return contextMatches && canonicalTaskGraphJson(envelope) === canonicalTaskGraphJson(expectedEnvelope)
    && canonicalTaskGraphJson(task.allowedActions) === canonicalTaskGraphJson(template.allowedActions)
    && canonicalTaskGraphJson(task.expectedOutputSchema) === canonicalTaskGraphJson(template.expectedOutputSchema)
}

function validOldLocation(node: StoredTaskGraphNode): boolean {
  const criteria = node.verification?.criteria.filter(item => item.id === "candidate-location") ?? []
  return criteria.length === 1 && criteria[0]?.check.kind === "candidate_location_in"
    && canonicalLocations(criteria[0].check.locations) !== undefined
}

function canonicalLocations(value: unknown): readonly string[] | undefined {
  const normalized = normalizeAgentLocationAllowlist(value)
  if (!normalized || !Array.isArray(value) || normalized.length !== value.length
    || normalized.some((item, index) => item !== value[index])
    || normalized.some(item => REMOTE_SELECTORS.has(item) || /[*?]/u.test(item))) return undefined
  return normalized
}

function validateLineage(nodes: readonly TaskGraphObjectiveLineageNode[], graph: PersistedGraphNodes): {
  nodes: readonly TaskGraphObjectiveLineageNode[]; added: readonly TaskGraphObjectiveLineageNode[]
} | undefined {
  if (!Array.isArray(nodes) || nodes.length < graph.length || nodes.length > TASK_GRAPH_LIMITS.maxPersistedNodes
    || Reflect.ownKeys(nodes).length !== nodes.length + 1) return undefined
  const persisted = new Map(graph.map(({ node }) => [node.key, node] as const)), byKey = new Map<string, TaskGraphObjectiveLineageNode>()
  for (const node of nodes) {
    if (!node || typeof node.key !== "string" || byKey.has(node.key) || !Array.isArray(node.dependsOn)) return undefined
    byKey.set(node.key, node)
  }
  for (const [key, stored] of persisted) {
    const node = byKey.get(key)
    if (!node || node.taskId !== stored.taskId || node.templateId !== stored.templateId
      || canonicalTaskGraphJson(node.dependsOn) !== canonicalTaskGraphJson(stored.dependsOn)
      || !sameOptionalJson(node.verification, stored.verification) || !sameOptionalJson(node.repairOf, stored.repairOf)) return undefined
  }
  const added = nodes.filter(node => !persisted.has(node.key))
  return added.some(node => node.taskId !== undefined) ? undefined : { nodes, added }
}

function hasFreshCurrentScout(nodes: readonly TaskGraphObjectiveLineageNode[], locations: readonly string[]): boolean {
  return nodes.some(node => {
    const result = node.verification && validateTaskGraphVerificationContract(node.verification, "scout")
    const check = result?.ok ? result.contract.criteria.find(item => item.id === "candidate-location")?.check : undefined
    return node.templateId === "scout" && (node.verificationDisposition === undefined || node.verificationDisposition === "typed")
      && !node.repairOf && node.dependsOn.length === 0
      && check?.kind === "candidate_location_in" && canonicalTaskGraphJson(check.locations) === canonicalTaskGraphJson(locations)
  })
}

function hasPendingLineageReference(nodes: readonly TaskGraphObjectiveLineageNode[], pending: ReadonlySet<string>): boolean {
  const byKey = new Map(nodes.map(node => [node.key, node] as const))
  for (const node of nodes) {
    if (pending.has(node.key)) continue
    if (node.repairOf && pending.has(node.repairOf.nodeKey)) return true
    const seen = new Set<string>(), stack = [...node.dependsOn]
    while (stack.length) {
      const key = stack.pop()!
      if (pending.has(key)) return true
      if (seen.has(key)) continue
      seen.add(key)
      const parent = byKey.get(key)
      if (!parent) return true
      stack.push(...parent.dependsOn)
    }
  }
  return false
}

function looksLikeScout(node: StoredTaskGraphNode, task: GraphTaskRow): boolean {
  return node.templateId === "scout" || task.role === "scout" || task.taskType === "job_discovery"
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}
function scopeValid(scope: TaskGraphExecutionScope): boolean {
  return !!scope && [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.stepId,
    scope.turnLeaseOwner, scope.parentLeaseOwner].every(validId) && scope.rootTaskId === scope.parentTaskId
    && Number.isSafeInteger(scope.turnLeaseVersion) && scope.turnLeaseVersion > 0
    && Number.isSafeInteger(scope.parentAttemptCount) && scope.parentAttemptCount > 0
}
function sameScope(left: TaskGraphExecutionScope, right: TaskGraphExecutionScope): boolean {
  return scopeValid(left) && scopeValid(right) && canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right)
}
function sameOptionalJson(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined ? left === right : canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right)
}
