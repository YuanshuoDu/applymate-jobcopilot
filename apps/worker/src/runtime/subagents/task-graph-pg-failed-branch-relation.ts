import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { parseTaskGraphBranchReplacement, type TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { taskGraphLifecycleKey, taskGraphFingerprint, taskGraphProposalKey } from "./task-graph-snapshot.js"

export const TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION = "agent-harness.v2.task-graph-failed-branch-repair.v1" as const
const OPERATION_KEY = /^agent\.plan\.reconciliation:sha256:[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
const MAX_REVISION = 2_147_483_646
type Row = Record<string, unknown>

export type TaskGraphFailedBranchIdentity = Readonly<{ nodeKey: string; taskId: string }>
export type TaskGraphFailedBranchEventIdentity = Readonly<{ id: string; sequence: string; idempotencyKey: string }>
export type TaskGraphFailedBranchRepairRelation = Readonly<{
  schemaVersion: typeof TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION
  operationKey: string
  graphRootTaskId: string
  observedRevision: number
  resultingRevision: number
  branchRoot: TaskGraphFailedBranchIdentity
  sources: readonly Readonly<{ source: TaskGraphFailedBranchIdentity; replacementKey: string }>[]
  failedSource: Readonly<{ source: TaskGraphFailedBranchIdentity; attemptCount: number; resultDigest: string; reportDigest: string; event: TaskGraphFailedBranchEventIdentity }>
  cancellations: readonly Readonly<{ source: TaskGraphFailedBranchIdentity; event: TaskGraphFailedBranchEventIdentity }>[]
  verifiedExternalDependencies: readonly Readonly<{ dependency: TaskGraphFailedBranchIdentity; attemptCount: number; resultDigest: string; reportDigest: string; completedEvent: TaskGraphFailedBranchEventIdentity }>[]
  planEvent: Readonly<{ id: string; sequence: string; idempotencyKey: string }>
  requestFingerprint: string
  agentPlanCall: Readonly<{ callId: string; stepId: string; expectedRevision: number; replaceBranch: TaskGraphBranchReplacement }>
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
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_REVISION }
function attempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function sequence(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return false
  return BigInt(value) <= MAX_SEQUENCE
}
function identity(value: unknown): TaskGraphFailedBranchIdentity | null {
  const row = record(value)
  return exact(row, ["nodeKey", "taskId"]) && text(row.nodeKey, 128) && text(row.taskId)
    ? { nodeKey: row.nodeKey, taskId: row.taskId } : null
}
function eventIdentity(value: unknown): TaskGraphFailedBranchEventIdentity | null {
  const row = record(value)
  return exact(row, ["id", "sequence", "idempotencyKey"]) && text(row.id) && sequence(row.sequence)
    && text(row.idempotencyKey) ? { id: row.id, sequence: row.sequence, idempotencyKey: row.idempotencyKey } : null
}
function digest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value) }

/** Fingerprint the whole original agent.plan call before any current-graph reads. */
export function taskGraphFailedBranchRepairFingerprint(input: Readonly<{
  expectedRevision: number
  replaceBranch: TaskGraphBranchReplacement
  nodes: readonly unknown[]
  rootSuccessCriteria?: readonly string[]
}>): string {
  return taskGraphFingerprint({ expectedRevision: input.expectedRevision, replaceBranch: input.replaceBranch, nodes: input.nodes,
    ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria }) })
}

/** Parse an immutable v4 receipt without accepting v1-v3 shapes or partial proof. */
export function parseTaskGraphFailedBranchRepairRelation(value: unknown): TaskGraphFailedBranchRepairRelation | null {
  try {
    const row = record(value)
    const sourceRows = row && Array.isArray(row.sources) ? row.sources : null
    const cancellationRows = row && Array.isArray(row.cancellations) ? row.cancellations : null
    const externalRows = row && Array.isArray(row.verifiedExternalDependencies) ? row.verifiedExternalDependencies : null
    if (!exact(row, ["schemaVersion", "operationKey", "graphRootTaskId", "observedRevision", "resultingRevision", "branchRoot", "sources",
      "failedSource", "cancellations", "verifiedExternalDependencies", "planEvent", "requestFingerprint", "agentPlanCall"])
      || row.schemaVersion !== TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION || typeof row.operationKey !== "string" || !OPERATION_KEY.test(row.operationKey)
      || !text(row.graphRootTaskId) || !revision(row.observedRevision) || row.observedRevision >= MAX_REVISION
      || !revision(row.resultingRevision) || !sourceRows
      || sourceRows.length < 2 || sourceRows.length > TASK_GRAPH_LIMITS.maxNodes || !cancellationRows || cancellationRows.length !== sourceRows.length - 1
      || !externalRows || externalRows.length > TASK_GRAPH_LIMITS.maxNodes || !digest(row.requestFingerprint)) return null

    const branchRoot = identity(row.branchRoot), call = record(row.agentPlanCall), failed = record(row.failedSource)
    if (!branchRoot || !exact(call, ["callId", "stepId", "expectedRevision", "replaceBranch"])
      || !text(call.callId) || !text(call.stepId) || call.expectedRevision !== row.observedRevision
      || !failed || !exact(failed, ["source", "attemptCount", "resultDigest", "reportDigest", "event"])) return null
    const parsedBranch = parseTaskGraphBranchReplacement(call.replaceBranch)
    const failedSource = identity(failed.source), failedEvent = eventIdentity(failed.event)
    if (!parsedBranch.ok || parsedBranch.value.root.nodeKey !== branchRoot.nodeKey || parsedBranch.value.root.taskId !== branchRoot.taskId
      || !failedSource || failedSource.nodeKey !== branchRoot.nodeKey || failedSource.taskId !== branchRoot.taskId
      || !attempt(failed.attemptCount) || !digest(failed.resultDigest) || !digest(failed.reportDigest) || !failedEvent
      || failedEvent.idempotencyKey !== taskGraphLifecycleKey(row.graphRootTaskId, branchRoot.nodeKey, failed.attemptCount, "task.failed")) return null

    const sourceBindings: TaskGraphFailedBranchRepairRelation["sources"][number][] = [], sourceKeys = new Set<string>(), taskIds = new Set<string>(), replacementKeys = new Set<string>()
    const requested = new Map(parsedBranch.value.sources.map(source => [source.nodeKey, source] as const))
    for (const valueSource of sourceRows) {
      const binding = record(valueSource), source = identity(binding?.source)
      if (!exact(binding, ["source", "replacementKey"]) || !source || !text(binding.replacementKey, 128)
        || sourceKeys.has(source.nodeKey) || taskIds.has(source.taskId) || replacementKeys.has(binding.replacementKey)) return null
      const expected = requested.get(source.nodeKey)
      if (!expected || expected.taskId !== source.taskId || expected.replacementKey !== binding.replacementKey) return null
      sourceKeys.add(source.nodeKey); taskIds.add(source.taskId); replacementKeys.add(binding.replacementKey)
      sourceBindings.push({ source, replacementKey: binding.replacementKey })
    }
    if (sourceBindings.length !== requested.size || !sourceKeys.has(branchRoot.nodeKey)) return null

    const expectedCancellations = sourceBindings.filter(source => source.source.nodeKey !== branchRoot.nodeKey)
    const cancellations: TaskGraphFailedBranchRepairRelation["cancellations"][number][] = [], cancellationKeys = new Set<string>(), eventIds = new Set([failedEvent.id])
    let previousCancellation = BigInt(failedEvent.sequence)
    for (const [index, valueCancellation] of cancellationRows.entries()) {
      const binding = record(valueCancellation), source = identity(binding?.source), event = eventIdentity(binding?.event)
      if (!exact(binding, ["source", "event"]) || !source || !event || !sourceKeys.has(source.nodeKey) || source.nodeKey === branchRoot.nodeKey
        || sourceBindings.find(item => item.source.nodeKey === source.nodeKey)?.source.taskId !== source.taskId
        || source.nodeKey !== expectedCancellations[index]?.source.nodeKey || source.taskId !== expectedCancellations[index]?.source.taskId
        || cancellationKeys.has(source.nodeKey) || eventIds.has(event.id)
        || event.idempotencyKey !== taskGraphLifecycleKey(row.graphRootTaskId, source.nodeKey, 0, "task.cancelled")
        || BigInt(event.sequence) <= previousCancellation) return null
      previousCancellation = BigInt(event.sequence); cancellationKeys.add(source.nodeKey); eventIds.add(event.id)
      cancellations.push({ source, event })
    }
    if (cancellationKeys.size !== sourceBindings.length - 1) return null

    const external: TaskGraphFailedBranchRepairRelation["verifiedExternalDependencies"][number][] = [], externalKeys = new Set<string>()
    let previousExternal = ""
    for (const valueDependency of externalRows) {
      const binding = record(valueDependency), dependency = identity(binding?.dependency), completedEvent = eventIdentity(binding?.completedEvent)
      if (!exact(binding, ["dependency", "attemptCount", "resultDigest", "reportDigest", "completedEvent"]) || !dependency
        || !attempt(binding.attemptCount) || !digest(binding.resultDigest) || !digest(binding.reportDigest) || !completedEvent
        || sourceKeys.has(dependency.nodeKey) || taskIds.has(dependency.taskId) || externalKeys.has(dependency.nodeKey)
        || dependency.nodeKey < previousExternal || eventIds.has(completedEvent.id)
        || completedEvent.idempotencyKey !== taskGraphLifecycleKey(row.graphRootTaskId, dependency.nodeKey, binding.attemptCount, "task.completed")
        || BigInt(completedEvent.sequence) >= BigInt(failedEvent.sequence)) return null
      previousExternal = dependency.nodeKey; externalKeys.add(dependency.nodeKey); eventIds.add(completedEvent.id)
      external.push({ dependency, attemptCount: binding.attemptCount, resultDigest: binding.resultDigest, reportDigest: binding.reportDigest, completedEvent })
    }

    const plan = record(row.planEvent), planEvent = plan && exact(plan, ["id", "sequence", "idempotencyKey"]) && text(plan.id)
      && sequence(plan.sequence) && text(plan.idempotencyKey) ? plan as { id: string; sequence: string; idempotencyKey: string } : null
    const planRevision = row.observedRevision + cancellations.length
    const finalCancellationSequence = cancellations.at(-1)?.event.sequence ?? failedEvent.sequence
    if (!planEvent || eventIds.has(planEvent.id) || BigInt(planEvent.sequence) <= BigInt(finalCancellationSequence)
      || row.resultingRevision !== planRevision + 1 || !revision(row.resultingRevision)
      || planEvent.idempotencyKey !== taskGraphProposalKey(row.graphRootTaskId, planRevision)) return null
    return {
      schemaVersion: TASK_GRAPH_FAILED_BRANCH_REPAIR_RELATION_SCHEMA_VERSION, operationKey: row.operationKey,
      graphRootTaskId: row.graphRootTaskId, observedRevision: row.observedRevision, resultingRevision: row.resultingRevision,
      branchRoot, sources: sourceBindings, failedSource: { source: failedSource, attemptCount: failed.attemptCount,
        resultDigest: failed.resultDigest, reportDigest: failed.reportDigest, event: failedEvent }, cancellations,
      verifiedExternalDependencies: external, planEvent, requestFingerprint: row.requestFingerprint,
      agentPlanCall: { callId: call.callId, stepId: call.stepId, expectedRevision: call.expectedRevision as number, replaceBranch: parsedBranch.value },
    }
  } catch { return null }
}
