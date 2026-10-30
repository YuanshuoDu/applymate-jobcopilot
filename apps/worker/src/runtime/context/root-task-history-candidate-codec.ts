import {
  parseTaskGraphVerificationCriterionIds,
  parseTaskGraphVerificationReport,
  taskGraphVerificationReportMatchesStatus,
} from "../subagents/task-graph-command-port.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import type { SubagentTaskStatus } from "../subagents/types.js"
import { parseRootTaskHistoryNodeLesson, type RootTaskHistoryNodeLesson } from "./root-task-history-lesson-projection.js"
import { projectRootTaskHistoryDiscoveryFootprint, type RootTaskHistoryDiscoveryFootprint } from "./root-task-history-discovery-footprint.js"
import { parseRootTaskHistoryReportedOutput, type RootTaskHistoryReportedOutput } from "./root-task-history-result-counts.js"
import * as rootTaskHistoryPlanShape from "./root-task-history-plan-shape.js"
import { parseRootTaskHistoryChronologyXid8 } from "./root-task-history-chronology-witness.js"

export type RootTaskHistorySafeNode = Readonly<{
  taskKind: "scout" | "analyst" | "writer" | "reviewer" | "other"; status: SubagentTaskStatus
  negativeReasonHints?: readonly TaskGraphVerificationReasonCode[]; lesson?: RootTaskHistoryNodeLesson
  reportedOutput?: RootTaskHistoryReportedOutput; priorScoutQueryFootprint?: RootTaskHistoryDiscoveryFootprint
}>
export type RootTaskHistoryCandidateNode = Readonly<{
  nodeOrdinal: number; projection: Omit<RootTaskHistorySafeNode, "lesson" | "reportedOutput" | "priorScoutQueryFootprint">
  lesson?: RootTaskHistoryNodeLesson; reportedOutput?: RootTaskHistoryReportedOutput
  priorScoutQueryFootprint?: RootTaskHistoryDiscoveryFootprint
}>
export type RootTaskHistoryCandidate = Readonly<{
  sourceTurnId: string; sourceRootTaskId: string; terminalSequence: bigint; terminalXid8?: bigint
  terminalWitnessEventId?: string; sourceSessionDiffers: boolean; safeNodes: readonly RootTaskHistoryCandidateNode[]
  lessonsBySourceOrdinal?: readonly (RootTaskHistoryNodeLesson | undefined)[]
  planShape?: rootTaskHistoryPlanShape.RootTaskHistoryPlanShape; identity: string
}>

type Row = Record<string, unknown>
type TaskKind = RootTaskHistorySafeNode["taskKind"]
const MAX_NODES = 8, MAX_REASON_HINTS = 8
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
export function isDenseRootTaskHistoryArray(value: unknown): value is unknown[] {
  try { return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => { const item = Object.getOwnPropertyDescriptor(value, String(index)); return !!item && "value" in item && item.enumerable }).every(Boolean) } catch { return false }
}
function nodeLessons(value: unknown, count: number, ordinals: readonly number[], nodes: readonly unknown[]): readonly (RootTaskHistoryNodeLesson | undefined)[] | undefined {
  if (!Array.isArray(value) || value.length !== count || !isDenseRootTaskHistoryArray(value)) return undefined
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
  if (!Array.isArray(value) || value.length !== nodes.length || !isDenseRootTaskHistoryArray(value)) return undefined
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
function projectNode(value: unknown): Omit<RootTaskHistorySafeNode, "lesson" | "reportedOutput"> | null {
  const node = record(value)
  if (!node || typeof node.templateId !== "string" || typeof node.status !== "string" || !STATUSES.has(node.status as SubagentTaskStatus)) return null
  const taskKind = TASK_KINDS.get(node.templateId) ?? "other"
  const hints = safeReasonHints(node)
  return { taskKind, status: node.status as SubagentTaskStatus, ...(hints ? { negativeReasonHints: hints } : {}) }
}

export function parseRootTaskHistoryCandidate(value: unknown, crossSession: boolean): RootTaskHistoryCandidate | null {
  const item = record(value), locality = item && ownDataProperty(item, "sourceSessionDiffers")
  const terminalXid8 = item && ownDataProperty(item, "terminalXid8"), witnessEventId = item && ownDataProperty(item, "terminalWitnessEventId")
  if (!item || !locality || !boundedText(item.sourceTurnId) || !boundedText(item.sourceRootTaskId)
    || typeof item.terminalSequence !== "bigint" || item.terminalSequence <= 0n
    || (crossSession && ((locality.present && typeof locality.value !== "boolean")
      || !terminalXid8?.present || !witnessEventId?.present
      || !boundedText(witnessEventId.value) || !parseRootTaskHistoryChronologyXid8(terminalXid8.value)))
    || (!crossSession && locality.present && locality.value !== false)) return null
  const hasSourceSessionDiffers = locality.present
  const sourceSessionDiffers = crossSession && (!hasSourceSessionDiffers || locality.value !== false)
  const hasOrdinals = Object.hasOwn(item, "sourceNodeOrdinals"), hasLessons = Object.hasOwn(item, "nodeLessons"), hasOutputs = Object.hasOwn(item, "reportedOutputs")
  const keys = ["sourceRootTaskId", "sourceTurnId", "taskGraph", "terminalSequence", ...(hasSourceSessionDiffers ? ["sourceSessionDiffers"] : []),
    ...(terminalXid8?.present ? ["terminalXid8"] : []), ...(witnessEventId?.present ? ["terminalWitnessEventId"] : []),
    ...(hasOrdinals ? ["sourceNodeOrdinals"] : []), ...(hasLessons ? ["nodeLessons"] : []), ...(hasOutputs ? ["reportedOutputs"] : [])].sort().join(",")
  if (!exact(item, keys)) return null
  const graph = record(item.taskGraph), graphTurn = graph && ownDataProperty(graph, "discoveryTurnEligibility")
  if (!graph || !graphTurn || !exact(graph, ["nodes", "revision", ...(graphTurn.present ? ["discoveryTurnEligibility"] : [])].sort().join(","))
    || graphTurn.present && graphTurn.value !== "ordinary" || !Number.isSafeInteger(graph.revision) || Number(graph.revision) < 0
    || !Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > MAX_NODES || !isDenseRootTaskHistoryArray(graph.nodes)) return null
  const ordinals = hasOrdinals ? rootTaskHistoryPlanShape.parseRootTaskHistorySourceOrdinals(item.sourceNodeOrdinals, graph.nodes.length) : undefined,
    effectiveOrdinals = ordinals ?? graph.nodes.map((_, index) => index + 1), ordinaryScoutHistory = graphTurn.present
  const planShape = !sourceSessionDiffers && ordinals ? rootTaskHistoryPlanShape.buildRootTaskHistoryPlanShape(graph, item.sourceNodeOrdinals) : undefined
  const lessons = hasLessons && ordinals ? nodeLessons(item.nodeLessons, graph.nodes.length, ordinals, graph.nodes) : undefined
  const outputs = hasOutputs ? reportedOutputs(item.reportedOutputs, graph.nodes) : undefined
  const nodes = graph.nodes.map((value, index) => {
    const projection = projectNode(value), priorScoutQueryFootprint = ordinaryScoutHistory ? projectRootTaskHistoryDiscoveryFootprint(value) : undefined
    return projection ? { nodeOrdinal: effectiveOrdinals[index]!, projection,
      ...(lessons?.[effectiveOrdinals[index]! - 1] ? { lesson: lessons[effectiveOrdinals[index]! - 1] } : {}),
      ...(outputs?.[index] ? { reportedOutput: outputs[index] } : {}), ...(priorScoutQueryFootprint ? { priorScoutQueryFootprint } : {}) } : null
  })
  if (nodes.some(node => node === null)) return null
  const safeNodes = (nodes as RootTaskHistoryCandidateNode[]).sort((left, right) =>
    compare(left.projection.taskKind, right.projection.taskKind) || compare(left.projection.status, right.projection.status)
      || compare(JSON.stringify(left.projection), JSON.stringify(right.projection)))
  return {
    sourceTurnId: item.sourceTurnId, sourceRootTaskId: item.sourceRootTaskId,
    terminalSequence: item.terminalSequence,
    ...(terminalXid8?.present ? { terminalXid8: parseRootTaskHistoryChronologyXid8(terminalXid8.value) } : {}),
    ...(witnessEventId?.present ? { terminalWitnessEventId: witnessEventId.value as string } : {}),
    sourceSessionDiffers, ...(lessons ? { lessonsBySourceOrdinal: lessons } : {}),
    ...(planShape ? { planShape } : {}),
    safeNodes, identity: JSON.stringify([item.sourceTurnId, item.sourceRootTaskId]),
  }
}
