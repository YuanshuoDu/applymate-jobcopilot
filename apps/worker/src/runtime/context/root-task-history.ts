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
import { filterRootTaskHistoryLessonsForEmittedNodes, parseRootTaskHistoryNodeLesson, type RootTaskHistoryNodeLesson } from "./root-task-history-lesson-projection.js"

export type ValidatedRootTaskHistoryOutcome = Readonly<{
  sourceTurnId: string
  sourceRootTaskId: string
  terminalSequence: bigint
  terminalAt?: Date
  taskGraph: TaskGraphCurrentState
  nodeLessons?: readonly (RootTaskHistoryNodeLesson | undefined)[]
}>

type TaskKind = "scout" | "analyst" | "writer" | "reviewer" | "other"
type SafeNode = Readonly<{
  taskKind: TaskKind
  status: SubagentTaskStatus
  negativeReasonHints?: readonly TaskGraphVerificationReasonCode[]
  lesson?: RootTaskHistoryNodeLesson
}>
type CandidateNode = Readonly<{ nodeOrdinal: number; projection: Omit<SafeNode, "lesson">; lesson?: RootTaskHistoryNodeLesson }>
type Candidate = ValidatedRootTaskHistoryOutcome & Readonly<{ safeNodes: readonly CandidateNode[]; identity: string }>
type SelectedTurn = { label: string; candidate: Candidate; nodes: CandidateNode[]; lessonOrdinals: Set<number> }
type Row = Record<string, unknown>

const MAX_CANDIDATES = 64
const MAX_TURNS = 2
const MAX_NODES = 8
const MAX_REASON_HINTS = 8
const MAX_CONTENT_BYTES = 8 * 1024
const STATUSES = new Set<SubagentTaskStatus>([
  "queued", "running", "retrying", "waiting", "waiting_for_user",
  "completed", "failed", "interrupted", "cancelled", "closed",
])
const TASK_KINDS = new Map<string, TaskKind>([
  ["scout", "scout"], ["analyst", "analyst"],
  ["cover_letter_writer", "writer"], ["cover_letter_reviewer", "reviewer"],
])
const NEGATIVE_REASON_CODES = new Set<TaskGraphVerificationReasonCode>([
  "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid",
  "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid",
  "canonical_evidence_ambiguous", "result_invalid", "result_ambiguous",
  "result_evidence_unbound", "repair_target_unresolved",
])

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Row : null
  } catch { return null }
}
function exact(value: Row, keys: string): boolean {
  const own = Reflect.ownKeys(value)
  return own.every((key): key is string => typeof key === "string") && own.sort().join(",") === keys
}
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
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
function projectNode(value: unknown): Omit<SafeNode, "lesson"> | null {
  const node = record(value)
  if (!node || typeof node.templateId !== "string" || typeof node.status !== "string" || !STATUSES.has(node.status as SubagentTaskStatus)) return null
  const taskKind = TASK_KINDS.get(node.templateId) ?? "other"
  const hints = safeReasonHints(node)
  return { taskKind, status: node.status as SubagentTaskStatus, ...(hints ? { negativeReasonHints: hints } : {}) }
}
function nodeLessons(value: unknown, count: number): readonly (RootTaskHistoryNodeLesson | undefined)[] | undefined {
  if (!Array.isArray(value) || value.length !== count || !dense(value)) return undefined
  const parsed = value.map(item => item === undefined ? undefined : parseRootTaskHistoryNodeLesson(item))
  return value.some((item, index) => item !== undefined && parsed[index]?.nodeOrdinal !== index + 1) ? undefined : parsed
}
function candidate(value: unknown, crossSession: boolean): Candidate | null {
  const item = record(value)
  const keys = crossSession ? "sourceRootTaskId,sourceTurnId,taskGraph,terminalAt,terminalSequence" : "sourceRootTaskId,sourceTurnId,taskGraph,terminalSequence"
  if (!item || (!exact(item, keys) && !exact(item, `nodeLessons,${keys}`))
    || !boundedText(item.sourceTurnId) || !boundedText(item.sourceRootTaskId)
    || typeof item.terminalSequence !== "bigint" || item.terminalSequence <= 0n
    || (crossSession && (!(item.terminalAt instanceof Date) || !Number.isFinite(item.terminalAt.getTime())))) return null
  const graph = record(item.taskGraph)
  if (!graph || !exact(graph, "nodes,revision") || !Number.isSafeInteger(graph.revision) || Number(graph.revision) < 0
    || !Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > MAX_NODES || !dense(graph.nodes)) return null
  const lessons = Object.hasOwn(item, "nodeLessons") ? nodeLessons(item.nodeLessons, graph.nodes.length) : undefined
  const nodes = graph.nodes.map((value, index) => {
    const projection = projectNode(value), lesson = lessons?.[index]
    return projection ? { nodeOrdinal: index + 1, projection, ...(lesson ? { lesson } : {}) } : null
  })
  if (nodes.some(node => node === null)) return null
  const safeNodes = (nodes as CandidateNode[]).sort((left, right) =>
    compare(left.projection.taskKind, right.projection.taskKind) || compare(left.projection.status, right.projection.status)
      || compare(JSON.stringify(left.projection), JSON.stringify(right.projection)))
  return {
    sourceTurnId: item.sourceTurnId, sourceRootTaskId: item.sourceRootTaskId,
    terminalSequence: item.terminalSequence, ...(crossSession ? { terminalAt: item.terminalAt as Date } : {}), taskGraph: item.taskGraph as TaskGraphCurrentState,
    ...(lessons ? { nodeLessons: lessons } : {}),
    safeNodes, identity: JSON.stringify([item.sourceTurnId, item.sourceRootTaskId]),
  }
}
function content(turns: readonly Readonly<{ label: string; nodes: readonly SafeNode[] }>[]) {
  return {
    kind: "root_task_history",
    informationalOnly: true,
    advisoryOnly: true,
    notCurrentEvidence: true,
    label: "Earlier outcomes for the same verifier objective; advisory context only.",
    turns,
  }
}
function emittedNodes(turn: SelectedTurn, withLessons: boolean): SafeNode[] {
  if (!withLessons || !turn.candidate.nodeLessons) return turn.nodes.map(node => node.projection)
  const facts = filterRootTaskHistoryLessonsForEmittedNodes(turn.candidate.nodeLessons, [...turn.lessonOrdinals])
  const byOrdinal = new Map<number, RootTaskHistoryNodeLesson>()
  for (const fact of facts) if (fact) byOrdinal.set(fact.nodeOrdinal, fact)
  return turn.nodes.map(node => {
    const lesson = byOrdinal.get(node.nodeOrdinal)
    return lesson ? { ...node.projection, lesson } : node.projection
  })
}
function emittedTurns(turns: readonly SelectedTurn[], withLessons: boolean) {
  return turns.map(turn => ({ label: turn.label, nodes: emittedNodes(turn, withLessons) }))
}
function withinContentLimit(turns: readonly SelectedTurn[], withLessons = false): boolean {
  const serialized = JSON.stringify({ id: "root-task-history", content: content(emittedTurns(turns, withLessons)) })
  return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= MAX_CONTENT_BYTES
}
function projectCandidates(values: readonly Candidate[], crossSession: boolean): ContextSeedBlock | undefined {
  const byIdentity = new Map<string, Candidate>()
  const conflicts = new Set<string>()
  for (const value of values) {
    if (conflicts.has(value.identity)) continue
    const previous = byIdentity.get(value.identity)
    if (!previous) byIdentity.set(value.identity, value)
    else if (previous.terminalSequence !== value.terminalSequence
      || previous.terminalAt?.getTime() !== value.terminalAt?.getTime()
      || JSON.stringify(previous.safeNodes) !== JSON.stringify(value.safeNodes)) {
      byIdentity.delete(value.identity)
      conflicts.add(value.identity)
    }
  }
  const ordered = [...byIdentity.values()].sort((left, right) => {
    if (crossSession) return (right.terminalAt as Date).getTime() - (left.terminalAt as Date).getTime()
      || compare(right.sourceTurnId, left.sourceTurnId) || compare(right.sourceRootTaskId, left.sourceRootTaskId)
    return left.terminalSequence > right.terminalSequence ? -1
      : left.terminalSequence < right.terminalSequence ? 1
        : compare(left.identity, right.identity)
  })
  const turns: SelectedTurn[] = []
  let nodeCount = 0
  let overflow = false
  for (const value of ordered) {
    if (turns.length >= MAX_TURNS || nodeCount >= MAX_NODES || overflow) break
    const entry: SelectedTurn = { label: "earlier terminal attempt", candidate: value, nodes: [], lessonOrdinals: new Set() }
    for (const node of value.safeNodes) {
      if (nodeCount >= MAX_NODES) break
      entry.nodes.push(node)
      if (node.lesson) entry.lessonOrdinals.add(node.nodeOrdinal)
      if (!withinContentLimit([...turns, entry])) {
        entry.nodes.pop()
        entry.lessonOrdinals.delete(node.nodeOrdinal)
        overflow = true
        break
      }
      nodeCount += 1
    }
    if (entry.nodes.length) turns.push(entry)
  }
  if (!turns.length) return undefined
  while (!withinContentLimit(turns, true)) {
    const turn = [...turns].reverse().find(value => value.lessonOrdinals.size > 0)
    const node = turn && [...turn.nodes].reverse().find(value => turn.lessonOrdinals.has(value.nodeOrdinal))
    if (!turn || !node) return undefined
    turn.lessonOrdinals.delete(node.nodeOrdinal)
  }
  return { id: "root-task-history", content: content(emittedTurns(turns, true)) }
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
