import {
  parseTaskGraphRepairReceipt,
  parseTaskGraphVerificationReport,
  taskGraphVerificationReportMatchesStatus,
  type TaskGraphCurrentNode,
  type TaskGraphCurrentState,
  type TaskGraphVerificationReport,
} from "../subagents/task-graph-command-port.js"
import { resolveTaskGraphRepairDependencies } from "../subagents/task-graph-dependency-context.js"
import type { LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { isValidTaskGraphRepairRelation } from "../planning/task-graph.js"
import { validateTaskGraphVerificationContract, type TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import type { StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"

export type RootTaskHistoryNodeLesson = Readonly<{
  ordinalScope: "source_graph_local"
  advisoryOnly: true
  notCurrentEvidence: true
  nodeOrdinal: number
  criterionFailures: readonly Readonly<{ criterionOrdinal: number; status: "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode }>[]
  successfulRepairs?: readonly Readonly<{ targetNodeOrdinal: number; targetCriterionOrdinals: readonly number[]; status: "passed" }>[]
}>

type Pair = Readonly<{ source: StoredTaskGraphNode; current: TaskGraphCurrentNode; status: string; failureReason: string | null; result: Record<string, unknown> | null }>
type Row = Record<string, unknown>
type SuccessfulRepair = NonNullable<RootTaskHistoryNodeLesson["successfulRepairs"]>[number]
const MAX_NODES = 8
const REASONS = new Set<TaskGraphVerificationReasonCode>([
  "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid", "role_mismatch",
  "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous", "result_invalid",
  "result_ambiguous", "result_evidence_unbound",
])

function exactDataRecord(value: unknown, keys: string): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value), own = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || own.some(key => typeof key !== "string") || [...own].sort().join(",") !== keys) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Row = Object.create(null) as Row
    for (const key of own as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result[key] = descriptor.value
    }
    return result
  } catch { return undefined }
}
function safeArray(value: unknown, maximum: number, allowEmpty: boolean): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const own = Reflect.ownKeys(value), length = Object.getOwnPropertyDescriptor(value, "length")?.value
    if (!Number.isSafeInteger(length) || Number(length) < (allowEmpty ? 0 : 1) || Number(length) > maximum || own.length !== Number(length) + 1) return undefined
    const result: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result.push(descriptor.value)
    }
    return result
  } catch { return undefined }
}
function ordinal(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_NODES }

/** Strictly reconstructs the closed, privacy-safe history fact shape. */
export function parseRootTaskHistoryNodeLesson(value: unknown): RootTaskHistoryNodeLesson | undefined {
  const hasRepairs = exactDataRecord(value, "advisoryOnly,criterionFailures,nodeOrdinal,notCurrentEvidence,ordinalScope,successfulRepairs")
  const row = hasRepairs ?? exactDataRecord(value, "advisoryOnly,criterionFailures,nodeOrdinal,notCurrentEvidence,ordinalScope")
  if (!row || row.ordinalScope !== "source_graph_local" || row.advisoryOnly !== true || row.notCurrentEvidence !== true || !ordinal(row.nodeOrdinal)) return undefined
  const failures = safeArray(row.criterionFailures, MAX_NODES, true)
  if (!failures) return undefined
  const criterionFailures: Array<RootTaskHistoryNodeLesson["criterionFailures"][number]> = []
  const seenCriteria = new Set<number>()
  for (const failure of failures) {
    const item = exactDataRecord(failure, "criterionOrdinal,reasonCode,status")
    const previous = criterionFailures.at(-1)
    if (!item || !ordinal(item.criterionOrdinal) || (item.status !== "failed" && item.status !== "unverified")
      || typeof item.reasonCode !== "string" || !REASONS.has(item.reasonCode as TaskGraphVerificationReasonCode)
      || seenCriteria.has(item.criterionOrdinal) || (previous && previous.criterionOrdinal >= item.criterionOrdinal)) return undefined
    seenCriteria.add(item.criterionOrdinal)
    criterionFailures.push({ criterionOrdinal: item.criterionOrdinal, status: item.status, reasonCode: item.reasonCode as TaskGraphVerificationReasonCode })
  }
  const successfulRepairs: Array<{ targetNodeOrdinal: number; targetCriterionOrdinals: readonly number[]; status: "passed" }> = []
  if (hasRepairs) {
    const repairs = safeArray(row.successfulRepairs, 1, false)
    if (!repairs) return undefined
    for (const repair of repairs) {
      const item = exactDataRecord(repair, "status,targetCriterionOrdinals,targetNodeOrdinal")
      const targets = item && safeArray(item.targetCriterionOrdinals, MAX_NODES, false)
      if (!item || item.status !== "passed" || !ordinal(item.targetNodeOrdinal) || item.targetNodeOrdinal >= row.nodeOrdinal
        || !targets || targets.some((target, index) => !ordinal(target) || (index > 0 && Number(target) <= Number(targets[index - 1])))) return undefined
      successfulRepairs.push({ targetNodeOrdinal: item.targetNodeOrdinal, targetCriterionOrdinals: targets as number[], status: "passed" })
    }
  }
  if (!criterionFailures.length && !successfulRepairs.length) return undefined
  return { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: row.nodeOrdinal,
    criterionFailures, ...(successfulRepairs.length ? { successfulRepairs } : {}) }
}

/** Keeps only links whose repair, target and exact target criteria survived final node selection. */
export function filterRootTaskHistoryLessonsForEmittedNodes(
  lessons: readonly (RootTaskHistoryNodeLesson | undefined)[], emittedNodeOrdinals: readonly number[],
): readonly (RootTaskHistoryNodeLesson | undefined)[] {
  const input = safeArray(lessons, MAX_NODES, true)
  if (!input) return []
  const omitted = input.map(() => undefined), emitted = safeArray(emittedNodeOrdinals, MAX_NODES, true)
  if (!emitted || emitted.some(value => !ordinal(value)) || new Set(emitted).size !== emitted.length) return omitted
  const selected = new Set(emitted as number[]), parsed = input.map((value, index) => {
    const lesson = value === undefined ? undefined : parseRootTaskHistoryNodeLesson(value)
    return lesson?.nodeOrdinal === index + 1 ? lesson : undefined
  })
  return parsed.map((lesson, index) => {
    if (!lesson || !selected.has(index + 1)) return undefined
    const links = lesson.successfulRepairs?.filter(link => selected.has(index + 1) && selected.has(link.targetNodeOrdinal)
      && parsed[link.targetNodeOrdinal - 1]?.criterionFailures && link.targetCriterionOrdinals.every(target =>
        parsed[link.targetNodeOrdinal - 1]!.criterionFailures.some(failure => failure.criterionOrdinal === target))) ?? []
    if (!lesson.criterionFailures.length && !links.length) return undefined
    return { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
      nodeOrdinal: lesson.nodeOrdinal, criterionFailures: lesson.criterionFailures, ...(links.length ? { successfulRepairs: links } : {}) }
  })
}

function parseResult(value: unknown): Row | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Row : null
  } catch { return null }
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
    pairs.push({ source, current, status: task.status, failureReason: task.failureReason, result })
  }
  return pairs
}

function criterionFailures(pair: Pair, ordinalBase: number): RootTaskHistoryNodeLesson["criterionFailures"] {
  const ids = pair.source.verification?.criteria.map(item => item.id)
  if (pair.source.verificationDisposition !== "typed" || !ids || !pair.current.verificationReport
    || !taskGraphVerificationReportMatchesStatus(pair.current.verificationReport, pair.status)
    || pair.current.verificationReport.status === "passed") return []
  return pair.current.verificationReport.criteria.flatMap((item, index) =>
    (item.status === "failed" || item.status === "unverified") && REASONS.has(item.reasonCode)
      ? [{ criterionOrdinal: ordinalBase + index + 1, status: item.status, reasonCode: item.reasonCode }] : [])
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
    const coverage = resolveTaskGraphRepairDependencies(loaded.snapshot, loaded.tasks, loaded.rootTaskId)
    const satisfied = new Set(coverage.satisfied.filter(key => loaded.state!.repairSatisfiedNodeKeys?.includes(key)))
    return pairs.map((pair, index) => {
      const failures = criterionFailures(pair, 0), repair = successfulRepair(pair, index, pairs, loaded, satisfied)
      return parseRootTaskHistoryNodeLesson({ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
        nodeOrdinal: index + 1, criterionFailures: failures, ...(repair ? { successfulRepairs: [repair] } : {}) })
    })
  } catch { return [] }
}
