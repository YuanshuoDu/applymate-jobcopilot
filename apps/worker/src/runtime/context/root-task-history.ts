import { Buffer } from "node:buffer"
import {
  parseTaskGraphVerificationCriterionIds,
  parseTaskGraphVerificationReport,
  taskGraphVerificationReportMatchesStatus,
  type TaskGraphCurrentState,
} from "../subagents/task-graph-command-port.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import type { SubagentTaskStatus } from "../subagents/types.js"
import type { ContextSeedBlock } from "./step-context-builder.js"
import { filterRootTaskHistoryLessonsForEmittedNodes, parseRootTaskHistoryNodeLesson, sanitizeRootTaskHistoryNodeLessonForCrossSession, type RootTaskHistoryNodeLesson } from "./root-task-history-lesson-projection.js"
import { parseRootTaskHistoryReportedOutput, type RootTaskHistoryReportedOutput } from "./root-task-history-result-counts.js"
import * as rootTaskHistoryPlanShape from "./root-task-history-plan-shape.js"

export type ValidatedRootTaskHistoryOutcome = Readonly<{
  sourceTurnId: string
  sourceRootTaskId: string
  terminalSequence: bigint; terminalAt?: Date; sourceSessionDiffers?: boolean
  taskGraph: TaskGraphCurrentState
  sourceNodeOrdinals?: readonly number[]
  nodeLessons?: readonly (RootTaskHistoryNodeLesson | undefined)[]
  reportedOutputs?: readonly (RootTaskHistoryReportedOutput | undefined)[]
}>
type TaskKind = "scout" | "analyst" | "writer" | "reviewer" | "other"
type SafeNode = Readonly<{
  taskKind: TaskKind
  status: SubagentTaskStatus
  negativeReasonHints?: readonly TaskGraphVerificationReasonCode[]
  lesson?: RootTaskHistoryNodeLesson
  reportedOutput?: RootTaskHistoryReportedOutput
}>
type CandidateNode = Readonly<{ nodeOrdinal: number; projection: Omit<SafeNode, "lesson" | "reportedOutput">; lesson?: RootTaskHistoryNodeLesson; reportedOutput?: RootTaskHistoryReportedOutput }>
type Candidate = Readonly<{ sourceTurnId: string; sourceRootTaskId: string; terminalSequence: bigint; terminalAt?: Date; sourceSessionDiffers: boolean; safeNodes: readonly CandidateNode[];
  lessonsBySourceOrdinal?: readonly (RootTaskHistoryNodeLesson | undefined)[]; planShape?: rootTaskHistoryPlanShape.RootTaskHistoryPlanShape; identity: string }>
type SelectedTurn = { label: string; candidate: Candidate; nodes: CandidateNode[]; lessonOrdinals: Set<number>; reportedOutputOrdinals: Set<number>; planShape?: rootTaskHistoryPlanShape.RootTaskHistoryPlanShape }
type Row = Record<string, unknown>
const MAX_CANDIDATES = 64
const MAX_TURNS = 2
const MAX_NODES = 8
const MAX_REASON_HINTS = 8
const MAX_CONTENT_BYTES = 8 * 1024
const STATUSES = new Set<SubagentTaskStatus>(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const TASK_KINDS = new Map<string, TaskKind>([["scout", "scout"], ["analyst", "analyst"], ["cover_letter_writer", "writer"], ["cover_letter_reviewer", "reviewer"]])
const NEGATIVE_REASON_CODES = new Set<TaskGraphVerificationReasonCode>(["criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid",
  "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous", "result_invalid", "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved"])
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Row : null
  } catch { return null }
}
function ownDataProperty(value: object, key: string): { present: boolean; value?: unknown } | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return { present: false }
    return "value" in descriptor ? { present: true, value: descriptor.value } : null
  } catch { return null }
}
function exact(value: Row, keys: string): boolean {
  const own = Reflect.ownKeys(value)
  return own.every((key): key is string => typeof key === "string") && own.sort().join(",") === keys
}
function dense(value: unknown): value is unknown[] {
  try { return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => { const item = Object.getOwnPropertyDescriptor(value, String(index)); return !!item && "value" in item && item.enumerable }).every(Boolean) } catch { return false }
}
function nodeLessons(value: unknown, count: number, ordinals: readonly number[], nodes: readonly unknown[]): readonly (RootTaskHistoryNodeLesson | undefined)[] | undefined {
  if (!Array.isArray(value) || value.length !== count || !dense(value)) return undefined
  const byOrdinal: Array<RootTaskHistoryNodeLesson | undefined> = Array.from({ length: count })
  for (let index = 0; index < count; index++) {
    const item = value[index]
    if (item === undefined) continue
    const templateId = record(nodes[index])?.templateId, role = typeof templateId === "string" ? TASK_KINDS.get(templateId) ?? "other" : "other"
    const lesson = parseRootTaskHistoryNodeLesson(item, role, projectNode(nodes[index])?.status)
    if (!lesson || lesson.nodeOrdinal !== ordinals[index]) return undefined
    byOrdinal[lesson.nodeOrdinal - 1] = lesson
  }
  return byOrdinal
}
function reportedOutputs(value: unknown, nodes: readonly unknown[]): readonly (RootTaskHistoryReportedOutput | undefined)[] | undefined {
  if (!Array.isArray(value) || value.length !== nodes.length || !dense(value)) return undefined
  return value.map((item, index) => {
    const node = record(nodes[index]), role = node?.templateId === "scout" || node?.templateId === "analyst" ? node.templateId : undefined
    if (item === undefined || !role || node?.status !== "completed") return undefined
    const parsed = safeReportedOutput(item, role), source = parseRootTaskHistoryReportedOutput(node.resultProjection, role)
    return parsed && JSON.stringify(parsed) === JSON.stringify(source) ? parsed : undefined
  })
}
function safeReportedOutput(value: unknown, role: "scout" | "analyst"): RootTaskHistoryReportedOutput | undefined {
  const row = record(value), countKey = role === "scout" ? "candidateCount" : "findingCount"
  if (!row || !exact(row, [countKey, "resultStatus", "role"].sort().join(",")) || row.role !== role
    || (row.resultStatus !== "completed" && row.resultStatus !== "partial")
    || !Number.isSafeInteger(row[countKey]) || Number(row[countKey]) < 0) return undefined
  return role === "scout" ? { role, candidateCount: Number(row[countKey]), resultStatus: row.resultStatus }
    : { role, findingCount: Number(row[countKey]), resultStatus: row.resultStatus }
}
function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function safeReasonHints(node: Row): readonly TaskGraphVerificationReasonCode[] | undefined {
  const ids = parseTaskGraphVerificationCriterionIds(node.verificationCriterionIds)
  if (!ids) return undefined
  const report = parseTaskGraphVerificationReport(node.verificationReport, ids)
  if (!report || !taskGraphVerificationReportMatchesStatus(report, String(node.status)) || report.status === "passed") return undefined
  const criterionHints = report.criteria
    .filter(criterion => criterion.status === "failed" || criterion.status === "unverified")
    .map(criterion => criterion.reasonCode)
    .filter(code => NEGATIVE_REASON_CODES.has(code))
  const unresolvedRepairHint = report.status === "unverified"
    && report.reasonCode === "repair_target_unresolved"
    && report.criteria.every(criterion => criterion.status === "passed")
    ? [report.reasonCode] : []
  const hints = [...new Set([...criterionHints, ...unresolvedRepairHint])].sort(compare).slice(0, MAX_REASON_HINTS)
  return hints.length ? hints : undefined
}
function projectNode(value: unknown): Omit<SafeNode, "lesson" | "reportedOutput"> | null {
  const node = record(value)
  if (!node || typeof node.templateId !== "string" || typeof node.status !== "string" || !STATUSES.has(node.status as SubagentTaskStatus)) return null
  const taskKind = TASK_KINDS.get(node.templateId) ?? "other"
  const hints = safeReasonHints(node)
  return { taskKind, status: node.status as SubagentTaskStatus, ...(hints ? { negativeReasonHints: hints } : {}) }
}
function candidate(value: unknown, crossSession: boolean): Candidate | null {
  const item = record(value), locality = item && ownDataProperty(item, "sourceSessionDiffers")
  if (!item || !locality || !boundedText(item.sourceTurnId) || !boundedText(item.sourceRootTaskId)
    || typeof item.terminalSequence !== "bigint" || item.terminalSequence <= 0n
    || (crossSession && ((locality.present && typeof locality.value !== "boolean")
      || !(item.terminalAt instanceof Date) || !Number.isFinite(item.terminalAt.getTime())))) return null
  const hasSourceSessionDiffers = locality.present
  const sourceSessionDiffers = crossSession && (!hasSourceSessionDiffers || locality.value !== false)
  const hasOrdinals = Object.hasOwn(item, "sourceNodeOrdinals"), hasLessons = Object.hasOwn(item, "nodeLessons"), hasOutputs = Object.hasOwn(item, "reportedOutputs")
  const keys = ["sourceRootTaskId", "sourceTurnId", "taskGraph", "terminalSequence", ...(crossSession ? [...(hasSourceSessionDiffers ? ["sourceSessionDiffers"] : []), "terminalAt"] : []),
    ...(hasOrdinals ? ["sourceNodeOrdinals"] : []), ...(hasLessons ? ["nodeLessons"] : []), ...(hasOutputs ? ["reportedOutputs"] : [])].sort().join(",")
  if (!exact(item, keys)) return null
  const graph = record(item.taskGraph)
  if (!graph || !exact(graph, "nodes,revision") || !Number.isSafeInteger(graph.revision) || Number(graph.revision) < 0
    || !Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > MAX_NODES || !dense(graph.nodes)) return null
  const ordinals = hasOrdinals ? rootTaskHistoryPlanShape.parseRootTaskHistorySourceOrdinals(item.sourceNodeOrdinals, graph.nodes.length) : undefined
  const effectiveOrdinals = ordinals ?? graph.nodes.map((_, index) => index + 1)
  const planShape = !sourceSessionDiffers && ordinals ? rootTaskHistoryPlanShape.buildRootTaskHistoryPlanShape(graph, item.sourceNodeOrdinals) : undefined
  const lessons = hasLessons && ordinals ? nodeLessons(item.nodeLessons, graph.nodes.length, ordinals, graph.nodes) : undefined
  const outputs = hasOutputs ? reportedOutputs(item.reportedOutputs, graph.nodes) : undefined
  const nodes = graph.nodes.map((value, index) => {
    const projection = projectNode(value)
    return projection ? { nodeOrdinal: effectiveOrdinals[index]!, projection,
      ...(lessons?.[effectiveOrdinals[index]! - 1] ? { lesson: lessons[effectiveOrdinals[index]! - 1] } : {}),
      ...(outputs?.[index] ? { reportedOutput: outputs[index] } : {}) } : null
  })
  if (nodes.some(node => node === null)) return null
  const safeNodes = (nodes as CandidateNode[]).sort((left, right) =>
    compare(left.projection.taskKind, right.projection.taskKind) || compare(left.projection.status, right.projection.status)
      || compare(JSON.stringify(left.projection), JSON.stringify(right.projection)))
  return {
    sourceTurnId: item.sourceTurnId, sourceRootTaskId: item.sourceRootTaskId,
    terminalSequence: item.terminalSequence, ...(crossSession ? { terminalAt: item.terminalAt as Date } : {}),
    sourceSessionDiffers, ...(lessons ? { lessonsBySourceOrdinal: lessons } : {}),
    ...(planShape ? { planShape } : {}),
    safeNodes, identity: JSON.stringify([item.sourceTurnId, item.sourceRootTaskId]),
  }
}
function content(turns: readonly Readonly<{ label: string; nodes: readonly SafeNode[]; planShape?: RootTaskHistoryPlanShape }>[], crossSession = false) {
  return {
    kind: "root_task_history",
    informationalOnly: true,
    advisoryOnly: true, notCurrentEvidence: true,
    ...(crossSession ? { historical: true } : {}),
    label: "Earlier outcomes for the same verifier objective; advisory context only.",
    turns,
  }
}
function emittedNodes(turn: SelectedTurn, withLessons: boolean, withReportedOutputs: boolean): SafeNode[] {
  const facts = withLessons && turn.candidate.lessonsBySourceOrdinal
    ? filterRootTaskHistoryLessonsForEmittedNodes(turn.candidate.lessonsBySourceOrdinal, [...turn.lessonOrdinals], turn.nodes.map(node => node.nodeOrdinal)) : []
  const byOrdinal = new Map<number, RootTaskHistoryNodeLesson>()
  for (const fact of facts) if (fact) byOrdinal.set(fact.nodeOrdinal, fact)
  return turn.nodes.map(node => {
    const lesson = byOrdinal.get(node.nodeOrdinal), publicLesson = lesson && turn.candidate.sourceSessionDiffers ? sanitizeRootTaskHistoryNodeLessonForCrossSession(lesson) : lesson
    const reportedOutput = withReportedOutputs && !turn.candidate.sourceSessionDiffers && turn.reportedOutputOrdinals.has(node.nodeOrdinal) ? node.reportedOutput : undefined
    return { ...node.projection, ...(reportedOutput ? { reportedOutput } : {}), ...(publicLesson ? { lesson: publicLesson } : {}) }
  })
}
function emittedTurns(turns: readonly SelectedTurn[], withLessons: boolean, withReportedOutputs: boolean) {
  return turns.map(turn => ({ label: turn.label, nodes: emittedNodes(turn, withLessons, withReportedOutputs),
    ...(turn.planShape ? { planShape: turn.planShape } : {}) }))
}
function withinContentLimit(turns: readonly SelectedTurn[], withLessons = false, withReportedOutputs = false, crossSession = false): boolean {
  const serialized = JSON.stringify({ id: "root-task-history", content: content(emittedTurns(turns, withLessons, withReportedOutputs), crossSession) })
  return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= MAX_CONTENT_BYTES
}
function projectCandidates(values: readonly Candidate[], crossSession: boolean): ContextSeedBlock | undefined {
  const byIdentity = new Map<string, Candidate>(), conflicts = new Set<string>()
  for (const value of values) {
    if (conflicts.has(value.identity)) continue
    const previous = byIdentity.get(value.identity)
    if (!previous) byIdentity.set(value.identity, value)
    else if (previous.terminalSequence !== value.terminalSequence || previous.sourceSessionDiffers !== value.sourceSessionDiffers || previous.terminalAt?.getTime() !== value.terminalAt?.getTime()
      || JSON.stringify(previous.safeNodes) !== JSON.stringify(value.safeNodes) || JSON.stringify(previous.planShape) !== JSON.stringify(value.planShape)) {
      byIdentity.delete(value.identity); conflicts.add(value.identity)
    }
  }
  const ordered = [...byIdentity.values()].sort((left, right) => crossSession
    ? right.terminalAt!.getTime() - left.terminalAt!.getTime() || compare(right.sourceTurnId, left.sourceTurnId)
    : left.terminalSequence > right.terminalSequence ? -1
      : left.terminalSequence < right.terminalSequence ? 1 : compare(left.identity, right.identity))
  const turns: SelectedTurn[] = []
  let nodeCount = 0
  for (const value of ordered) {
    if (turns.length >= MAX_TURNS || nodeCount >= MAX_NODES) break
    const entry: SelectedTurn = { label: "earlier terminal attempt", candidate: value, nodes: [], lessonOrdinals: new Set(), reportedOutputOrdinals: new Set() }
    for (const node of value.safeNodes) {
      if (nodeCount >= MAX_NODES) break
      entry.nodes.push(node)
      if (node.lesson) entry.lessonOrdinals.add(node.nodeOrdinal)
      if (node.reportedOutput) entry.reportedOutputOrdinals.add(node.nodeOrdinal)
      nodeCount += 1
    }
    rootTaskHistoryPlanShape.attachCompleteRootTaskHistoryPlanShape(entry, value.planShape, entry.nodes.map(node => node.nodeOrdinal))
    if (entry.nodes.length) turns.push(entry)
  }
  if (!turns.length) return undefined
  rootTaskHistoryPlanShape.dropRootTaskHistoryPlanShapesUntilFits(turns, selectedTurns => withinContentLimit(selectedTurns, true, true, crossSession))
  if (!withinContentLimit(turns, true, true, crossSession)) {
    for (const turn of [...turns].reverse()) for (const node of [...turn.nodes].reverse()) turn.reportedOutputOrdinals.delete(node.nodeOrdinal)
  }
  while (!withinContentLimit(turns, true, false, crossSession)) {
    const turn = [...turns].reverse().find(value => value.lessonOrdinals.size > 0)
    const node = turn && [...turn.nodes].reverse().find(value => turn.lessonOrdinals.has(value.nodeOrdinal))
    if (!turn || !node) break
    turn.lessonOrdinals.delete(node.nodeOrdinal)
  }
  while (!withinContentLimit(turns, false, false, crossSession)) {
    const turn = turns.at(-1), node = turn?.nodes.pop()
    if (!turn || !node) return undefined
    turn.lessonOrdinals.delete(node.nodeOrdinal); turn.reportedOutputOrdinals.delete(node.nodeOrdinal); nodeCount -= 1
    if (!turn.nodes.length) turns.pop()
  }
  return { id: "root-task-history", content: content(emittedTurns(turns, true, true), crossSession) }
}
/** Projects bounded typed historical outcomes; private source identity is used only for ordering and deduplication. */
export function projectRootTaskHistory(
  outcomes: readonly ValidatedRootTaskHistoryOutcome[],
  crossSession = false,
): ContextSeedBlock | undefined {
  if (!Array.isArray(outcomes) || outcomes.length === 0 || outcomes.length > MAX_CANDIDATES || !dense(outcomes)) return undefined
  const candidates = outcomes.map(value => candidate(value, crossSession))
  if (candidates.some(value => value === null)) return undefined
  return projectCandidates(candidates as Candidate[], crossSession)
}
