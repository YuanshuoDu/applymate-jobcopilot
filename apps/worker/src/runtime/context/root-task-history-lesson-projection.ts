import {
  parseTaskGraphRepairReceipt,
  parseTaskGraphVerificationReport,
  taskGraphVerificationReportMatchesStatus,
  type TaskGraphCurrentNode,
  type TaskGraphCurrentState,
  type TaskGraphVerificationReport,
} from "../subagents/task-graph-command-port.js"
import { resolveTaskGraphRepairDependencies } from "../subagents/task-graph-dependency-context.js"
import { classifyCurrentTaskGraphExecutionFailure } from "../subagents/task-graph-failure-category.js"
import type { GraphTaskRow, LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { isValidTaskGraphRepairRelation } from "../planning/task-graph.js"
import { validateTaskGraphVerificationContract, type TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import type { StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import { currentTaskGraph } from "../subagents/task-graph-pg-state.js"
import { parseRootTaskHistoryReportedOutput, type RootTaskHistoryReportedOutput } from "./root-task-history-result-counts.js"
import { describeValidatedRootTaskHistoryChecks, filterRootTaskHistoryLessonsForEmittedNodes,
  parseRootTaskHistoryNodeLesson, type RootTaskHistoryCheckDescriptor, type RootTaskHistoryNodeLesson } from "./root-task-history-lesson-schema.js"

export { filterRootTaskHistoryLessonsForEmittedNodes, parseRootTaskHistoryNodeLesson }
export type { RootTaskHistoryCheckDescriptor, RootTaskHistoryNodeLesson } from "./root-task-history-lesson-schema.js"

export type LoadedRootTaskHistoryGraphProjection = Readonly<{
  taskGraph: TaskGraphCurrentState
  sourceNodeOrdinals: readonly number[]
  nodeLessons?: readonly (RootTaskHistoryNodeLesson | undefined)[]
  reportedOutputs?: readonly (RootTaskHistoryReportedOutput | undefined)[]
}>

type Pair = Readonly<{ source: StoredTaskGraphNode; current: TaskGraphCurrentNode; task: GraphTaskRow; status: string; failureReason: unknown; result: Record<string, unknown> | null }>
type Row = Record<string, unknown>
type SuccessfulRepair = NonNullable<RootTaskHistoryNodeLesson["successfulRepairs"]>[number]
const MAX_NODES = 8
const REASONS = new Set<TaskGraphVerificationReasonCode>([
  "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid", "role_mismatch",
  "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous", "result_invalid",
  "result_ambiguous", "result_evidence_unbound",
])

function parseResult(value: unknown): Row | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Row : null
  } catch { return null }
}
function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
  } catch { return undefined }
}
function sameReport(left: TaskGraphVerificationReport | undefined, right: TaskGraphVerificationReport | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}
function sameRepair(left: TaskGraphCurrentNode["repairOf"], right: StoredTaskGraphNode["repairOf"]): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}
function pairSource(loaded: LoadedGraph, graph: TaskGraphCurrentState): Pair[] | undefined {
  const snapshot = loaded.snapshot, state = loaded.state
  if (!loaded.item || !snapshot || !state || loaded.item.revision !== state.revision || graph.revision !== state.revision
    || snapshot.nodes.length < 1 || snapshot.nodes.length > MAX_NODES
    || state.nodes.length !== snapshot.nodes.length || graph.nodes.length !== snapshot.nodes.length) return undefined
  const pairs: Pair[] = []
  for (let index = 0; index < snapshot.nodes.length; index++) {
    const source = snapshot.nodes[index]!, stateNode = state.nodes[index]!, current = graph.nodes[index]!, task = loaded.tasks.get(source.taskId)
    if (!task || task.id !== source.taskId || stateNode.key !== source.key || stateNode.templateId !== source.templateId || stateNode.taskId !== source.taskId
      || current.key !== source.key || current.templateId !== source.templateId || current.taskId !== source.taskId
      || stateNode.goal !== source.goal || current.goal !== source.goal
      || JSON.stringify(stateNode.successCriteria) !== JSON.stringify(source.successCriteria)
      || JSON.stringify(current.successCriteria) !== JSON.stringify(source.successCriteria)
      || JSON.stringify(stateNode.dependsOn) !== JSON.stringify(source.dependsOn)
      || JSON.stringify(current.dependsOn) !== JSON.stringify(source.dependsOn)
      || stateNode.verificationDisposition !== source.verificationDisposition
      || JSON.stringify(stateNode.verification ?? null) !== JSON.stringify(source.verification ?? null)
      || JSON.stringify(stateNode.repairOf ?? null) !== JSON.stringify(source.repairOf ?? null)
      || stateNode.status !== task.status || current.status !== task.status || !sameRepair(current.repairOf, source.repairOf)) return undefined
    const validation = source.verificationDisposition === "typed" && source.verification
      ? validateTaskGraphVerificationContract(source.verification, source.templateId) : undefined
    const contract = validation?.ok ? validation.contract : undefined
    const ids = contract?.criteria.map(criterion => criterion.id)
    if (source.verificationDisposition === "typed" && (!contract || !ids || !Array.isArray(current.verificationCriterionIds)
      || current.verificationCriterionIds.join("\0") !== ids.join("\0") || task.role !== contract.role)
      || source.verificationDisposition !== "typed" && current.verificationCriterionIds !== undefined) return undefined
    const result = parseResult(task.result)
    const report = ids ? parseTaskGraphVerificationReport(result?.taskGraphVerificationReport, ids) : undefined
    if (!sameReport(report, current.verificationReport)) return undefined
    pairs.push({ source, current, task, status: task.status, failureReason: ownDataValue(task, "failureReason"), result })
  }
  return pairs
}

function criterionFailures(pair: Pair, ordinalBase: number,
  checks: readonly (RootTaskHistoryCheckDescriptor | undefined)[] = []): RootTaskHistoryNodeLesson["criterionFailures"] {
  const ids = pair.source.verification?.criteria.map(item => item.id)
  if (pair.source.verificationDisposition !== "typed" || !ids || !pair.current.verificationReport
    || !taskGraphVerificationReportMatchesStatus(pair.current.verificationReport, pair.status)
    || pair.current.verificationReport.status === "passed") return []
  return pair.current.verificationReport.criteria.flatMap((item, index) =>
    (item.status === "failed" || item.status === "unverified") && REASONS.has(item.reasonCode)
      ? [{ criterionOrdinal: ordinalBase + index + 1, status: item.status, reasonCode: item.reasonCode,
        ...(checks[index] ? { check: checks[index] } : {}) }] : [])
}

function executionFailureCategory(pair: Pair) {
  return classifyCurrentTaskGraphExecutionFailure(pair.task, {
    hasVerifiedReport: Boolean(pair.current.verificationReport),
    isNative: Boolean(pair.source.nativeDelegation || pair.current.native || pair.current.nativeResult),
  })
}

/** Validates a lesson before rebuilding only the cross-session failure and repair allowlist. */
export function sanitizeRootTaskHistoryNodeLessonForCrossSession(value: unknown): RootTaskHistoryNodeLesson | undefined {
  const lesson = parseRootTaskHistoryNodeLesson(value)
  if (!lesson) return undefined
  const criterionFailures = lesson.criterionFailures.map(({ criterionOrdinal, status, reasonCode }) => ({ criterionOrdinal, status, reasonCode }))
  const successfulRepairs = lesson.successfulRepairs?.map(({ targetNodeOrdinal, targetCriterionOrdinals, status }) => ({
    targetNodeOrdinal, targetCriterionOrdinals: [...targetCriterionOrdinals], status,
  }))
  if (!criterionFailures.length && !successfulRepairs?.length) return undefined
  return {
    ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
    nodeOrdinal: lesson.nodeOrdinal, criterionFailures,
    ...(successfulRepairs?.length ? { successfulRepairs } : {}),
  }
}

function successfulRepair(pair: Pair, index: number, pairs: readonly Pair[], loaded: LoadedGraph, satisfiedTargets: ReadonlySet<string>): SuccessfulRepair | undefined {
  const repair = pair.source, relation = repair.repairOf, report = pair.current.verificationReport
  if (!relation || pair.source.verificationDisposition !== "typed" || pair.status !== "completed" || pair.failureReason !== null
    || !report || report.status !== "passed" || !taskGraphVerificationReportMatchesStatus(report, pair.status)) return undefined
  const targetIndex = loaded.snapshot!.nodes.findIndex(node => node.key === relation.nodeKey)
  const targetPair = targetIndex >= 0 ? pairs[targetIndex] : undefined, target = targetPair?.source, targetReport = targetPair?.current.verificationReport
  if (!targetPair || !target || targetIndex >= index || !isValidTaskGraphRepairRelation(repair, target)
    || relation.graphRootTaskId !== loaded.rootTaskId || target.taskId !== relation.taskId || repair.templateId !== target.templateId
    || !satisfiedTargets.has(target.key) || targetPair.status !== "failed" || !targetReport
    || !taskGraphVerificationReportMatchesStatus(targetReport, targetPair.status) || targetReport.status === "passed") return undefined
  const targetFailures = criterionFailures(targetPair, 0), targetOrdinals = relation.criterionIds.map(id => target.verification?.criteria.findIndex(item => item.id === id) ?? -1)
  if (!targetOrdinals.length || targetOrdinals.some(value => value < 0 || !targetFailures.some(failure => failure.criterionOrdinal === value + 1))) return undefined
  const ids = repair.verification?.criteria.map(item => item.id) ?? []
  const parsedReport = parseTaskGraphVerificationReport(pair.result?.taskGraphVerificationReport, ids)
  const receipt = parseTaskGraphRepairReceipt(pair.result?.taskGraphRepairReceipt, { repairOf: relation, repairNodeKey: repair.key, repairTaskId: repair.taskId, report: parsedReport })
  if (!receipt || !sameReport(parsedReport, report) || JSON.stringify(receipt) !== JSON.stringify(pair.current.repairReceipt)) return undefined
  return { targetNodeOrdinal: targetIndex + 1, targetCriterionOrdinals: targetOrdinals.map(value => value + 1).sort((a, b) => a - b), status: "passed" }
}

/** Derives only allowlisted local-ordinal facts from an owner-loaded graph and its matching public view. */
export function deriveRootTaskHistoryLessonFacts(loaded: LoadedGraph, currentGraph: TaskGraphCurrentState): readonly (RootTaskHistoryNodeLesson | undefined)[] {
  try {
    const pairs = pairSource(loaded, currentGraph)
    if (!pairs || !loaded.snapshot || !loaded.state) return []
    const checkMatrix = describeValidatedRootTaskHistoryChecks(loaded.snapshot)
    if (!checkMatrix || checkMatrix.length !== pairs.length) return []
    const coverage = resolveTaskGraphRepairDependencies(loaded.snapshot, loaded.tasks, loaded.rootTaskId)
    const satisfied = new Set(coverage.satisfied.filter(key => loaded.state!.repairSatisfiedNodeKeys?.includes(key)))
    return pairs.map((pair, index) => {
      const failures = criterionFailures(pair, 0, checkMatrix[index] ?? []), repair = successfulRepair(pair, index, pairs, loaded, satisfied)
      const category = !failures.length && !repair ? executionFailureCategory(pair) : undefined
      return parseRootTaskHistoryNodeLesson({ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
        nodeOrdinal: index + 1, criterionFailures: failures, ...(repair ? { successfulRepairs: [repair] } : {}),
        ...(category ? { executionFailureCategory: category } : {}) }, pair.source.verification?.role, pair.status)
    })
  } catch { return [] }
}

/** Projects one already-loaded source graph and facts aligned to its public node order. */
export function projectLoadedRootTaskHistoryGraph(loaded: LoadedGraph, historicalOnly = false): LoadedRootTaskHistoryGraphProjection | undefined {
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.item.revision !== loaded.state.revision
    || loaded.snapshot.nodes.length < 1 || loaded.snapshot.nodes.length > MAX_NODES) return undefined
  const taskGraph = currentTaskGraph(loaded), ordinalByKey = new Map(loaded.snapshot.nodes.map((node, index) => [node.key, index + 1] as const))
  if (taskGraph.revision !== loaded.state.revision || taskGraph.nodes.length !== loaded.snapshot.nodes.length) return undefined
  const ordinals: number[] = [], seen = new Set<number>()
  for (const node of taskGraph.nodes) {
    const ordinal = ordinalByKey.get(node.key)
    if (ordinal === undefined || seen.has(ordinal)) return undefined
    seen.add(ordinal); ordinals.push(ordinal)
  }
  const sourceLessons = deriveRootTaskHistoryLessonFacts(loaded, taskGraph)
  const projectedLessons = ordinals.map(value => sourceLessons[value - 1])
  const nodeLessons = historicalOnly
    ? projectedLessons.map(sanitizeRootTaskHistoryNodeLessonForCrossSession) : projectedLessons
  const reportedOutputs = historicalOnly ? undefined : taskGraph.nodes.map(node => node.templateId === "scout" || node.templateId === "analyst"
    ? parseRootTaskHistoryReportedOutput(node.resultProjection, node.templateId) : undefined)
  return {
    taskGraph, sourceNodeOrdinals: ordinals,
    ...(nodeLessons.some(Boolean) ? { nodeLessons } : {}),
    ...(reportedOutputs?.some(Boolean) ? { reportedOutputs } : {}),
  }
}
