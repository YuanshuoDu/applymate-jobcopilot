import { TASK_GRAPH_LIMITS, type TaskGraphNodeProposal } from "../planning/task-graph.js"
import { validateTaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { parseTaskGraphOperationalFailureReplacement, type TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import { normalizeTaskGraphPlanningNodes, type TaskGraphModelNodeProposal } from "../tools/task-graph-planning-input.js"
import { canonicalTaskGraphJson, taskGraphFingerprint, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { normalizeRootPlanCriteria } from "./root-plan-criteria.js"

export const TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION = "agent-harness.v2.task-graph-operational-failed-branch.v1" as const
const OPERATION_KEY = /^agent\.plan\.reconciliation:sha256:[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
export type TaskGraphOperationalFailureReason = "child_resume_unavailable" | "child_resume_evidence_unavailable" | "task_graph_child_deadline_exceeded"
type Row = Record<string, unknown>

export type TaskGraphOperationalIdentity = Readonly<{ nodeKey: string; taskId: string }>
export type TaskGraphOperationalEventIdentity = Readonly<{ id: string; sequence: string; idempotencyKey: string }>
export type TaskGraphOperationalFailedBranchRelation = Readonly<{
  schemaVersion: typeof TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION
  operationKey: string
  graphRootTaskId: string
  observedRevision: number
  resultingRevision: number
  failedSource: Readonly<{ source: TaskGraphOperationalIdentity; attemptCount: number; failureReason: TaskGraphOperationalFailureReason; resultDigest: string; event: TaskGraphOperationalEventIdentity }>
  observedGraphEvent: TaskGraphOperationalEventIdentity
  sources: readonly Readonly<{ source: TaskGraphOperationalIdentity; replacementKey: string }>[]
  priorCancellations: readonly Readonly<{ source: TaskGraphOperationalIdentity; event: TaskGraphOperationalEventIdentity }>[]
  cancellations: readonly Readonly<{ source: TaskGraphOperationalIdentity; event: TaskGraphOperationalEventIdentity }>[]
  verifiedExternalDependencies: readonly Readonly<{ dependency: TaskGraphOperationalIdentity; attemptCount: number; resultDigest: string; reportDigest: string; completedEvent: TaskGraphOperationalEventIdentity }>[]
  planEvent: Readonly<{ id: string; sequence: string; idempotencyKey: string }>
  requestFingerprint: string
  agentPlanCall: Readonly<{ callId: string; stepId: string; expectedRevision: number; replaceOperationalFailure: TaskGraphOperationalFailureReplacement }>
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
function denseArray(value: unknown, max: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
      || Reflect.ownKeys(value).length !== value.length + 1) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (let index = 0; index < value.length; index += 1) {
      const item = descriptors[String(index)]
      if (!item || !item.enumerable || !("value" in item)) return null
    }
    return value
  } catch { return null }
}
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < 2_147_483_647 }
function attempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function sequence(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_SEQUENCE
}
function digest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value) }
function failureReason(value: unknown): value is TaskGraphOperationalFailureReason {
  return value === "child_resume_unavailable" || value === "child_resume_evidence_unavailable"
    || value === "task_graph_child_deadline_exceeded"
}
function identity(value: unknown): TaskGraphOperationalIdentity | null {
  const row = record(value)
  return exact(row, ["nodeKey", "taskId"]) && text(row.nodeKey, 128) && text(row.taskId)
    ? { nodeKey: row.nodeKey, taskId: row.taskId } : null
}
function stringList(value: unknown, minimum: number, maximum: number, maxLength: number): string[] | null {
  const values = denseArray(value, maximum), result: string[] = []
  if (!values || values.length < minimum) return null
  for (const item of values) { if (!text(item, maxLength)) return null; result.push(item) }
  return result
}
function eventIdentity(value: unknown): TaskGraphOperationalEventIdentity | null {
  const row = record(value)
  return exact(row, ["id", "sequence", "idempotencyKey"]) && text(row.id) && sequence(row.sequence) && text(row.idempotencyKey)
    ? { id: row.id, sequence: row.sequence, idempotencyKey: row.idempotencyKey } : null
}
function same(left: unknown, right: unknown): boolean { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) }
export function parseTaskGraphOperationalFailurePlanNodes(value: unknown): readonly TaskGraphNodeProposal[] | null {
  const rows = denseArray(value, TASK_GRAPH_LIMITS.maxNodes)
  if (!rows?.length) return null
  const nodes: TaskGraphNodeProposal[] = []
  for (const valueNode of rows) {
    const row = record(valueNode), hasVerification = row !== null && Object.hasOwn(row, "verification")
    if (!exact(row, hasVerification ? ["key", "templateId", "goal", "successCriteria", "dependsOn", "verification"]
      : ["key", "templateId", "goal", "successCriteria", "dependsOn"]) || Object.hasOwn(row, "repairOf")) return null
    const { key, templateId, goal } = row
    const successCriteria = stringList(row.successCriteria, 1, TASK_GRAPH_LIMITS.maxSuccessCriteria, TASK_GRAPH_LIMITS.maxCriterionLength)
    const dependsOn = stringList(row.dependsOn, 0, TASK_GRAPH_LIMITS.maxDependencies, TASK_GRAPH_LIMITS.maxKeyLength)
    if (!text(key, TASK_GRAPH_LIMITS.maxKeyLength) || !text(templateId, TASK_GRAPH_LIMITS.maxTemplateIdLength)
      || !text(goal, TASK_GRAPH_LIMITS.maxGoalLength) || !successCriteria || !dependsOn) return null
    const verification = hasVerification ? validateTaskGraphVerificationContract(row.verification, templateId) : null
    if (hasVerification && (!verification || !verification.ok)) return null
    nodes.push({ key, templateId, goal, successCriteria, dependsOn,
      ...(verification?.ok ? { verification: verification.contract } : {}) })
  }
  return nodes
}

export function taskGraphOperationalFailedBranchFingerprint(input: Readonly<{
  rootTaskId: string
  expectedRevision: number
  replaceOperationalFailure: TaskGraphOperationalFailureReplacement
  nodes: readonly TaskGraphModelNodeProposal[]
  rootSuccessCriteria?: readonly string[]
}>): string {
  const normalized = normalizeTaskGraphPlanningNodes(input.nodes, input.rootTaskId)
  const criteria = normalizeRootPlanCriteria(input.rootSuccessCriteria)
  if (!normalized.ok || criteria === null) throw new Error("task_graph_operational_failed_branch_call_invalid")
  return taskGraphFingerprint({ expectedRevision: input.expectedRevision, replaceOperationalFailure: input.replaceOperationalFailure,
    nodes: normalized.nodes, ...(criteria === undefined ? {} : { rootSuccessCriteria: criteria }) })
}

export function parseTaskGraphOperationalFailedBranchRelation(value: unknown): TaskGraphOperationalFailedBranchRelation | null {
  try {
    const row = record(value), graphRootTaskId = row?.graphRootTaskId
    const sourceRows = row && denseArray(row.sources, TASK_GRAPH_LIMITS.maxNodes)
    const priorRows = row && denseArray(row.priorCancellations, TASK_GRAPH_LIMITS.maxNodes)
    const cancellationRows = row && denseArray(row.cancellations, TASK_GRAPH_LIMITS.maxNodes)
    const externalRows = row && denseArray(row.verifiedExternalDependencies, TASK_GRAPH_LIMITS.maxNodes)
    if (!exact(row, ["schemaVersion", "operationKey", "graphRootTaskId", "observedRevision", "resultingRevision", "failedSource", "observedGraphEvent", "sources",
      "priorCancellations", "cancellations", "verifiedExternalDependencies", "planEvent", "requestFingerprint", "agentPlanCall"])
      || row.schemaVersion !== TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION || typeof row.operationKey !== "string" || !OPERATION_KEY.test(row.operationKey)
       || !text(graphRootTaskId) || !revision(row.observedRevision) || !revision(row.resultingRevision) || row.resultingRevision <= row.observedRevision
      || !sourceRows || sourceRows.length < 1 || sourceRows.length > TASK_GRAPH_LIMITS.maxNodes || !cancellationRows
      || !priorRows || priorRows.length > TASK_GRAPH_LIMITS.maxNodes || !externalRows || externalRows.length > TASK_GRAPH_LIMITS.maxNodes
      || !digest(row.requestFingerprint)) return null

    const failed = record(row.failedSource), call = record(row.agentPlanCall), failedSource = identity(failed?.source)
    const failedEvent = eventIdentity(failed?.event), observedGraphEvent = eventIdentity(row.observedGraphEvent)
    const callMode = call && parseTaskGraphOperationalFailureReplacement(call.replaceOperationalFailure)
    if (!exact(failed, ["source", "attemptCount", "failureReason", "resultDigest", "event"]) || !failedSource || !attempt(failed.attemptCount)
      || !failureReason(failed.failureReason) || !digest(failed.resultDigest) || !failedEvent || !observedGraphEvent
      || !exact(call, ["callId", "stepId", "expectedRevision", "replaceOperationalFailure"]) || !text(call.callId) || !text(call.stepId)
      || call.expectedRevision !== row.observedRevision || !callMode?.ok || failedSource.nodeKey !== callMode.value.root.nodeKey
      || failedSource.taskId !== callMode.value.root.taskId || !same(callMode.value, call.replaceOperationalFailure)
       || failedEvent.idempotencyKey !== taskGraphLifecycleKey(graphRootTaskId, failedSource.nodeKey, failed.attemptCount, "task.failed")) return null

    const sources: TaskGraphOperationalFailedBranchRelation["sources"][number][] = [], sourceKeys = new Set<string>(), taskIds = new Set<string>(), replacementKeys = new Set<string>()
    const requested = new Map(callMode.value.sources.map(source => [source.nodeKey, source] as const))
    for (const valueSource of sourceRows) {
      const binding = record(valueSource), source = identity(binding?.source)
      if (!exact(binding, ["source", "replacementKey"]) || !source || !text(binding.replacementKey, 128)
        || sourceKeys.has(source.nodeKey) || taskIds.has(source.taskId) || replacementKeys.has(binding.replacementKey)) return null
      const expected = requested.get(source.nodeKey)
      if (!expected || expected.taskId !== source.taskId || expected.replacementKey !== binding.replacementKey) return null
      sourceKeys.add(source.nodeKey); taskIds.add(source.taskId); replacementKeys.add(binding.replacementKey)
      sources.push({ source, replacementKey: binding.replacementKey })
    }
    if (sources.length !== requested.size || !sourceKeys.has(failedSource.nodeKey)
      || sources.find(source => source.source.nodeKey === failedSource.nodeKey)?.source.taskId !== failedSource.taskId) return null

    const expectedCancellations = sources.filter(source => source.source.nodeKey !== failedSource.nodeKey)
    const expectedByNode = new Map(expectedCancellations.map(value => [value.source.nodeKey, value.source] as const))
    const priorCancellations: TaskGraphOperationalFailedBranchRelation["priorCancellations"][number][] = []
    const cancellations: TaskGraphOperationalFailedBranchRelation["cancellations"][number][] = []
    const cancellationNodes = new Set<string>(), cancellationTaskIds = new Set<string>(), eventIds = new Set([failedEvent.id]), eventKeys = new Set<string>()
    const parseCancellations = (values: unknown[], output: typeof cancellations): boolean => {
      let previous = BigInt(failedEvent.sequence)
      for (const valueCancellation of values) {
        const binding = record(valueCancellation), source = identity(binding?.source), event = eventIdentity(binding?.event)
        const expected = source && expectedByNode.get(source.nodeKey)
        if (!exact(binding, ["source", "event"]) || !source || !event || !expected || source.taskId !== expected.taskId
          || cancellationNodes.has(source.nodeKey) || cancellationTaskIds.has(source.taskId) || eventIds.has(event.id)
          || event.idempotencyKey !== taskGraphLifecycleKey(graphRootTaskId, source.nodeKey, 0, "task.cancelled")
          || BigInt(event.sequence) <= previous || eventKeys.has(event.idempotencyKey)) return false
        previous = BigInt(event.sequence); eventIds.add(event.id); eventKeys.add(event.idempotencyKey)
        cancellationNodes.add(source.nodeKey); cancellationTaskIds.add(source.taskId); output.push({ source, event })
      }
      return true
    }
    if (!parseCancellations(priorRows, priorCancellations) || !parseCancellations(cancellationRows, cancellations)
      || cancellationNodes.size !== expectedCancellations.length
      || expectedCancellations.some(value => !cancellationNodes.has(value.source.nodeKey))) return null

    const failedSequence = BigInt(failedEvent.sequence), observedSequence = BigInt(observedGraphEvent.sequence)
    if (observedSequence < failedSequence || priorCancellations.some(value => BigInt(value.event.sequence) > observedSequence)) return null
    const lastPrior = priorCancellations.at(-1)?.event
    const observedAliasesFailure = observedGraphEvent.id === failedEvent.id && same(observedGraphEvent, failedEvent)
    const observedAliasesPrior = lastPrior !== undefined && observedGraphEvent.id === lastPrior.id && same(observedGraphEvent, lastPrior)
    if (observedGraphEvent.id === failedEvent.id && !observedAliasesFailure
      || lastPrior && observedGraphEvent.id === lastPrior.id && !observedAliasesPrior
      || !observedAliasesFailure && !observedAliasesPrior && eventIds.has(observedGraphEvent.id)) return null
    eventIds.add(observedGraphEvent.id)

    const external: TaskGraphOperationalFailedBranchRelation["verifiedExternalDependencies"][number][] = [], externalKeys = new Set<string>()
    let previousExternal = ""
    for (const valueDependency of externalRows) {
      const binding = record(valueDependency), dependency = identity(binding?.dependency), completedEvent = eventIdentity(binding?.completedEvent)
      if (!exact(binding, ["dependency", "attemptCount", "resultDigest", "reportDigest", "completedEvent"]) || !dependency
        || !attempt(binding.attemptCount) || !digest(binding.resultDigest) || !digest(binding.reportDigest) || !completedEvent
        || sourceKeys.has(dependency.nodeKey) || taskIds.has(dependency.taskId) || externalKeys.has(dependency.nodeKey)
        || dependency.nodeKey < previousExternal || eventIds.has(completedEvent.id)
        || completedEvent.idempotencyKey !== taskGraphLifecycleKey(graphRootTaskId, dependency.nodeKey, binding.attemptCount, "task.completed")
        || BigInt(completedEvent.sequence) >= BigInt(failedEvent.sequence)) return null
      previousExternal = dependency.nodeKey; externalKeys.add(dependency.nodeKey); eventIds.add(completedEvent.id)
      external.push({ dependency, attemptCount: binding.attemptCount, resultDigest: binding.resultDigest, reportDigest: binding.reportDigest, completedEvent })
    }

    const plan = record(row.planEvent), planEvent = plan && exact(plan, ["id", "sequence", "idempotencyKey"]) && text(plan.id)
      && sequence(plan.sequence) && text(plan.idempotencyKey) ? plan as { id: string; sequence: string; idempotencyKey: string } : null
    const planRevision = row.observedRevision + cancellations.length
    if (!planEvent || eventIds.has(planEvent.id) || BigInt(planEvent.sequence) <= observedSequence
      || cancellations.some(item => BigInt(item.event.sequence) >= BigInt(planEvent.sequence))
      || row.resultingRevision !== planRevision + 1 || planEvent.idempotencyKey !== taskGraphProposalKey(graphRootTaskId, planRevision)) return null
    return { schemaVersion: TASK_GRAPH_OPERATIONAL_FAILED_BRANCH_RELATION_SCHEMA_VERSION, operationKey: row.operationKey,
      graphRootTaskId, observedRevision: row.observedRevision, resultingRevision: row.resultingRevision,
      failedSource: { source: failedSource, attemptCount: failed.attemptCount as number, failureReason: failed.failureReason,
        resultDigest: failed.resultDigest, event: failedEvent }, observedGraphEvent, sources, priorCancellations, cancellations, verifiedExternalDependencies: external,
      planEvent, requestFingerprint: row.requestFingerprint, agentPlanCall: { callId: call.callId as string, stepId: call.stepId as string,
        expectedRevision: call.expectedRevision as number, replaceOperationalFailure: callMode.value } }
  } catch { return null }
}
