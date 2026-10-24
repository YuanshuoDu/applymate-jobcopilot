import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { parseTaskGraphBranchReplacement, type TaskGraphBranchReplacement } from "../planning/task-graph-branch-replacement.js"
import { taskGraphFingerprint, taskGraphProposalKey } from "./task-graph-snapshot.js"

export const TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION = "agent-harness.v2.task-graph-branch-repair.v1" as const
const OPERATION_KEY = /^agent\.plan\.reconciliation:sha256:[0-9a-f]{64}$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
const MAX_GRAPH_REVISION = 2_147_483_646
type Row = Record<string, unknown>

export type TaskGraphBranchRepairIdentity = Readonly<{ nodeKey: string; taskId: string }>
export type TaskGraphBranchRepairEventIdentity = Readonly<{ id: string; sequence: string }>
export type TaskGraphBranchRepairRelation = Readonly<{
  schemaVersion: typeof TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION
  operationKey: string
  graphRootTaskId: string
  observedRevision: number
  resultingRevision: number
  root: TaskGraphBranchRepairIdentity
  sources: readonly Readonly<{
    source: TaskGraphBranchRepairIdentity
    replacementKey: string
    cancellationEvent: TaskGraphBranchRepairEventIdentity
  }>[]
  planEvent: TaskGraphBranchRepairEventIdentity & Readonly<{ idempotencyKey: string }>
  replacementFingerprint: string
  agentPlanCall: Readonly<{
    callId: string
    stepId: string
    expectedRevision: number
    replaceBranch: TaskGraphBranchReplacement
  }>
}>

export type TaskGraphBranchRepairCall = Readonly<{
  expectedRevision: number
  replaceBranch: TaskGraphBranchReplacement
  nodes: readonly unknown[]
  rootSuccessCriteria?: readonly string[]
}>

function object(value: unknown): Row | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== "string")
      || keys.some(key => { const descriptor = descriptors[key as string]; return !descriptor || !descriptor.enumerable || !("value" in descriptor) })) return null
    return value as Row
  } catch { return null }
}

function exact(value: Row | null, keys: readonly string[]): value is Row {
  if (!value) return false
  const actual = Reflect.ownKeys(value)
  const expected = new Set(keys)
  return actual.length === expected.size && actual.every(key => typeof key === "string" && expected.delete(key))
    && expected.size === 0
}

function denseArray(value: unknown, minimum: number, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length
        || !descriptors[key]?.enumerable || !("value" in descriptors[key]!)))) return null
    return Array.from({ length: value.length }, (_, index) => descriptors[String(index)]?.value)
  } catch { return null }
}

function id(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function sequence(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return false
  return BigInt(value) <= MAX_SEQUENCE
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_GRAPH_REVISION
}

/** Hashes only immutable agent.plan input, so replay does not depend on the current graph. */
export function taskGraphBranchRepairFingerprint(input: TaskGraphBranchRepairCall): string {
  return taskGraphFingerprint({ expectedRevision: input.expectedRevision, replaceBranch: input.replaceBranch,
    nodes: input.nodes, ...(input.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: input.rootSuccessCriteria }) })
}

export function parseTaskGraphBranchRepairRelation(value: unknown): TaskGraphBranchRepairRelation | null {
  try {
    const row = object(value)
    const sourceRows = row ? denseArray(row.sources, 2, TASK_GRAPH_LIMITS.maxNodes) : null
    if (!exact(row, ["schemaVersion", "operationKey", "graphRootTaskId", "observedRevision", "resultingRevision", "root", "sources", "planEvent", "replacementFingerprint", "agentPlanCall"])
      || row.schemaVersion !== TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION || typeof row.operationKey !== "string" || !OPERATION_KEY.test(row.operationKey)
      || !id(row.graphRootTaskId) || !revision(row.observedRevision) || !sourceRows
      || row.observedRevision > MAX_GRAPH_REVISION - sourceRows.length - 1
      || row.resultingRevision !== row.observedRevision + sourceRows.length + 1 || !revision(row.resultingRevision)
      || typeof row.replacementFingerprint !== "string" || !FINGERPRINT.test(row.replacementFingerprint)) return null

    const root = object(row.root), call = object(row.agentPlanCall)
    if (!exact(root, ["nodeKey", "taskId"]) || !id(root.nodeKey, 128) || !id(root.taskId)
      || !exact(call, ["callId", "stepId", "expectedRevision", "replaceBranch"]) || !id(call.callId) || !id(call.stepId)
      || call.expectedRevision !== row.observedRevision) return null
    const parsedBranch = parseTaskGraphBranchReplacement(call.replaceBranch)
    if (!parsedBranch.ok || parsedBranch.value.root.nodeKey !== root.nodeKey || parsedBranch.value.root.taskId !== root.taskId
      || parsedBranch.value.sources.length !== sourceRows.length) return null

    const bindings: TaskGraphBranchRepairRelation["sources"][number][] = []
    const keys = new Set<string>(), tasks = new Set<string>(), replacements = new Set<string>(), eventIds = new Set<string>()
    const branchKeys = new Set(parsedBranch.value.sources.map(source => source.nodeKey))
    let previousSequence = 0n
    for (const valueSource of sourceRows) {
      const binding = object(valueSource), source = object(binding?.source), event = object(binding?.cancellationEvent)
      if (!exact(binding, ["source", "replacementKey", "cancellationEvent"]) || !exact(source, ["nodeKey", "taskId"])
        || !id(source.nodeKey, 128) || !id(source.taskId) || !id(binding.replacementKey, 128)
        || keys.has(source.nodeKey) || tasks.has(source.taskId) || replacements.has(binding.replacementKey)
        || branchKeys.has(binding.replacementKey) || !exact(event, ["id", "sequence"]) || !id(event.id) || !sequence(event.sequence)
        || eventIds.has(event.id) || BigInt(event.sequence) <= previousSequence) return null
      const expected = parsedBranch.value.sources.find(item => item.nodeKey === source.nodeKey)
      if (!expected || expected.taskId !== source.taskId || expected.replacementKey !== binding.replacementKey) return null
      previousSequence = BigInt(event.sequence)
      keys.add(source.nodeKey); tasks.add(source.taskId); replacements.add(binding.replacementKey); eventIds.add(event.id)
      bindings.push({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: binding.replacementKey,
        cancellationEvent: { id: event.id, sequence: event.sequence } })
    }
    if (!keys.has(root.nodeKey)) return null

    const plan = object(row.planEvent)
    if (!exact(plan, ["id", "sequence", "idempotencyKey"]) || !id(plan.id) || !sequence(plan.sequence)
      || !id(plan.idempotencyKey, 256) || eventIds.has(plan.id) || BigInt(plan.sequence) <= previousSequence
      || plan.idempotencyKey !== taskGraphProposalKey(row.graphRootTaskId, row.observedRevision)) return null
    return {
      schemaVersion: TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
      operationKey: row.operationKey,
      graphRootTaskId: row.graphRootTaskId,
      observedRevision: row.observedRevision,
      resultingRevision: row.resultingRevision,
      root: { nodeKey: root.nodeKey, taskId: root.taskId },
      sources: bindings,
      planEvent: { id: plan.id, sequence: plan.sequence, idempotencyKey: plan.idempotencyKey },
      replacementFingerprint: row.replacementFingerprint,
      agentPlanCall: { callId: call.callId, stepId: call.stepId, expectedRevision: call.expectedRevision as number,
        replaceBranch: parsedBranch.value },
    }
  } catch { return null }
}
