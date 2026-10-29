import { Buffer } from "node:buffer"
import type { TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"
import type { ContextSeedBlock } from "./step-context-builder.js"
import { filterRootTaskHistoryLessonsForEmittedNodes, sanitizeRootTaskHistoryNodeLessonForCrossSession, type RootTaskHistoryNodeLesson } from "./root-task-history-lesson-projection.js"
import type { RootTaskHistoryReportedOutput } from "./root-task-history-result-counts.js"
import * as rootTaskHistoryPlanShape from "./root-task-history-plan-shape.js"
import { isDenseRootTaskHistoryArray, parseRootTaskHistoryCandidate, type RootTaskHistoryCandidate, type RootTaskHistoryCandidateNode, type RootTaskHistorySafeNode } from "./root-task-history-candidate-codec.js"
export type ValidatedRootTaskHistoryOutcome = Readonly<{
  sourceTurnId: string
  sourceRootTaskId: string
  terminalSequence: bigint; terminalXid8?: string; terminalWitnessEventId?: string; sourceSessionDiffers?: boolean
  taskGraph: TaskGraphCurrentState
  sourceNodeOrdinals?: readonly number[]
  nodeLessons?: readonly (RootTaskHistoryNodeLesson | undefined)[]
  reportedOutputs?: readonly (RootTaskHistoryReportedOutput | undefined)[]
}>
type SelectedTurn = { label: string; candidate: RootTaskHistoryCandidate; nodes: RootTaskHistoryCandidateNode[]; lessonOrdinals: Set<number>; reportedOutputOrdinals: Set<number>; footprintOrdinals: Set<number>; planShape?: rootTaskHistoryPlanShape.RootTaskHistoryPlanShape }
const MAX_CANDIDATES = 64
const MAX_TURNS = 2
const MAX_NODES = 8
const MAX_CONTENT_BYTES = 8 * 1024
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function content(turns: readonly Readonly<{ label: string; nodes: readonly RootTaskHistorySafeNode[]; planShape?: rootTaskHistoryPlanShape.RootTaskHistoryPlanShape }>[], crossSession = false) {
  return {
    kind: "root_task_history",
    informationalOnly: true,
    advisoryOnly: true, notCurrentEvidence: true,
    ...(crossSession ? { historical: true } : {}),
    label: "Earlier outcomes for the same verifier objective; advisory context only.",
    turns,
  }
}
function emittedNodes(turn: SelectedTurn, withLessons: boolean, withReportedOutputs: boolean): RootTaskHistorySafeNode[] {
  const facts = withLessons && turn.candidate.lessonsBySourceOrdinal
    ? filterRootTaskHistoryLessonsForEmittedNodes(turn.candidate.lessonsBySourceOrdinal, [...turn.lessonOrdinals], turn.nodes.map(node => node.nodeOrdinal)) : []
  const byOrdinal = new Map<number, RootTaskHistoryNodeLesson>()
  for (const fact of facts) if (fact) byOrdinal.set(fact.nodeOrdinal, fact)
  return turn.nodes.map(node => {
    const lesson = byOrdinal.get(node.nodeOrdinal), publicLesson = lesson && turn.candidate.sourceSessionDiffers ? sanitizeRootTaskHistoryNodeLessonForCrossSession(lesson) : lesson,
      priorScoutQueryFootprint = !turn.candidate.sourceSessionDiffers && turn.footprintOrdinals.has(node.nodeOrdinal) ? node.priorScoutQueryFootprint : undefined
    const reportedOutput = withReportedOutputs && !turn.candidate.sourceSessionDiffers && turn.reportedOutputOrdinals.has(node.nodeOrdinal) ? node.reportedOutput : undefined
    return { ...node.projection, ...(reportedOutput ? { reportedOutput } : {}), ...(priorScoutQueryFootprint ? { priorScoutQueryFootprint } : {}), ...(publicLesson ? { lesson: publicLesson } : {}) }
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
function projectCandidates(values: readonly RootTaskHistoryCandidate[], crossSession: boolean): ContextSeedBlock | undefined {
  const byIdentity = new Map<string, RootTaskHistoryCandidate>(), conflicts = new Set<string>()
  for (const value of values) {
    if (conflicts.has(value.identity)) continue
    const previous = byIdentity.get(value.identity)
    if (!previous) byIdentity.set(value.identity, value)
    else if (previous.terminalSequence !== value.terminalSequence || previous.sourceSessionDiffers !== value.sourceSessionDiffers
      || previous.terminalXid8 !== value.terminalXid8 || previous.terminalWitnessEventId !== value.terminalWitnessEventId
      || JSON.stringify(previous.safeNodes) !== JSON.stringify(value.safeNodes) || JSON.stringify(previous.planShape) !== JSON.stringify(value.planShape)) {
      byIdentity.delete(value.identity); conflicts.add(value.identity)
    }
  }
  const ordered = [...byIdentity.values()].sort((left, right) => crossSession
    ? left.terminalXid8! > right.terminalXid8! ? -1 : left.terminalXid8! < right.terminalXid8! ? 1 : compare(right.sourceTurnId, left.sourceTurnId)
    : left.terminalSequence > right.terminalSequence ? -1
      : left.terminalSequence < right.terminalSequence ? 1 : compare(left.identity, right.identity))
  const turns: SelectedTurn[] = []
  let nodeCount = 0
  for (const value of ordered) {
    if (turns.length >= MAX_TURNS || nodeCount >= MAX_NODES) break
    const entry: SelectedTurn = { label: "earlier terminal attempt", candidate: value, nodes: [], lessonOrdinals: new Set(), reportedOutputOrdinals: new Set(), footprintOrdinals: new Set() }
    for (const node of value.safeNodes) {
      if (nodeCount >= MAX_NODES) break
      entry.nodes.push(node)
      if (node.lesson) entry.lessonOrdinals.add(node.nodeOrdinal)
      if (node.reportedOutput) entry.reportedOutputOrdinals.add(node.nodeOrdinal); if (node.priorScoutQueryFootprint) entry.footprintOrdinals.add(node.nodeOrdinal)
      nodeCount += 1
    }
    rootTaskHistoryPlanShape.attachCompleteRootTaskHistoryPlanShape(entry, value.planShape, entry.nodes.map(node => node.nodeOrdinal))
    if (entry.nodes.length) turns.push(entry)
  }
  if (!turns.length) return undefined
  for (const turn of [...turns].reverse()) for (const node of [...turn.nodes].reverse()) if (!withinContentLimit(turns, true, true, crossSession)) turn.footprintOrdinals.delete(node.nodeOrdinal)
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
  if (!Array.isArray(outcomes) || outcomes.length === 0 || outcomes.length > MAX_CANDIDATES || !isDenseRootTaskHistoryArray(outcomes)) return undefined
  const candidates = outcomes.map(value => parseRootTaskHistoryCandidate(value, crossSession))
  if (candidates.some(value => value === null)) return undefined
  return projectCandidates(candidates as RootTaskHistoryCandidate[], crossSession)
}
