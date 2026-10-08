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

export type ValidatedRootTaskHistoryOutcome = Readonly<{
  sourceTurnId: string
  sourceRootTaskId: string
  terminalSequence: bigint
  taskGraph: TaskGraphCurrentState
}>

type TaskKind = "scout" | "analyst" | "writer" | "reviewer" | "other"
type SafeNode = Readonly<{
  taskKind: TaskKind
  status: SubagentTaskStatus
  negativeReasonHints?: readonly TaskGraphVerificationReasonCode[]
}>
type Candidate = ValidatedRootTaskHistoryOutcome & Readonly<{ safeNodes: readonly SafeNode[]; identity: string }>
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
  const hints = [...new Set(report.criteria
    .filter(criterion => criterion.status === "failed" || criterion.status === "unverified")
    .map(criterion => criterion.reasonCode)
    .filter(code => NEGATIVE_REASON_CODES.has(code)))].sort(compare).slice(0, MAX_REASON_HINTS)
  return hints.length ? hints : undefined
}
function projectNode(value: unknown): SafeNode | null {
  const node = record(value)
  if (!node || typeof node.templateId !== "string" || typeof node.status !== "string" || !STATUSES.has(node.status as SubagentTaskStatus)) return null
  const taskKind = TASK_KINDS.get(node.templateId) ?? "other"
  const hints = safeReasonHints(node)
  return { taskKind, status: node.status as SubagentTaskStatus, ...(hints ? { negativeReasonHints: hints } : {}) }
}
function candidate(value: unknown): Candidate | null {
  const item = record(value)
  if (!item || !exact(item, "sourceRootTaskId,sourceTurnId,taskGraph,terminalSequence")
    || !boundedText(item.sourceTurnId) || !boundedText(item.sourceRootTaskId)
    || typeof item.terminalSequence !== "bigint" || item.terminalSequence <= 0n) return null
  const graph = record(item.taskGraph)
  if (!graph || !exact(graph, "nodes,revision") || !Number.isSafeInteger(graph.revision) || Number(graph.revision) < 0
    || !Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > MAX_NODES || !dense(graph.nodes)) return null
  const nodes = graph.nodes.map(projectNode)
  if (nodes.some(node => node === null)) return null
  const safeNodes = (nodes as SafeNode[]).sort((left, right) =>
    compare(left.taskKind, right.taskKind) || compare(left.status, right.status)
      || compare(JSON.stringify(left), JSON.stringify(right)))
  return {
    sourceTurnId: item.sourceTurnId, sourceRootTaskId: item.sourceRootTaskId,
    terminalSequence: item.terminalSequence, taskGraph: item.taskGraph as TaskGraphCurrentState,
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
function withinContentLimit(turns: readonly Readonly<{ label: string; nodes: readonly SafeNode[] }>[]): boolean {
  const serialized = JSON.stringify({ id: "root-task-history", content: content(turns) })
  return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= MAX_CONTENT_BYTES
}
function projectCandidates(values: readonly Candidate[]): ContextSeedBlock | undefined {
  const byIdentity = new Map<string, Candidate>()
  const conflicts = new Set<string>()
  for (const value of values) {
    if (conflicts.has(value.identity)) continue
    const previous = byIdentity.get(value.identity)
    if (!previous) byIdentity.set(value.identity, value)
    else if (previous.terminalSequence !== value.terminalSequence || JSON.stringify(previous.safeNodes) !== JSON.stringify(value.safeNodes)) {
      byIdentity.delete(value.identity)
      conflicts.add(value.identity)
    }
  }
  const ordered = [...byIdentity.values()].sort((left, right) =>
    left.terminalSequence > right.terminalSequence ? -1
      : left.terminalSequence < right.terminalSequence ? 1
        : compare(left.identity, right.identity))
  const turns: Array<{ label: string; nodes: SafeNode[] }> = []
  let nodeCount = 0
  let overflow = false
  for (const value of ordered) {
    if (turns.length >= MAX_TURNS || nodeCount >= MAX_NODES || overflow) break
    const entry = { label: "earlier terminal attempt", nodes: [] as SafeNode[] }
    for (const node of value.safeNodes) {
      if (nodeCount >= MAX_NODES) break
      entry.nodes.push(node)
      if (!withinContentLimit([...turns, entry])) {
        entry.nodes.pop()
        overflow = true
        break
      }
      nodeCount += 1
    }
    if (entry.nodes.length) turns.push(entry)
  }
  if (!turns.length) return undefined
  if (!withinContentLimit(turns)) return undefined
  return { id: "root-task-history", content: content(turns) }
}

/** Projects bounded typed historical outcomes; private source identity is used only for ordering and deduplication. */
export function projectRootTaskHistory(
  outcomes: readonly ValidatedRootTaskHistoryOutcome[],
): ContextSeedBlock | undefined {
  if (!Array.isArray(outcomes) || outcomes.length === 0 || outcomes.length > MAX_CANDIDATES || !dense(outcomes)) return undefined
  const candidates = outcomes.map(candidate)
  if (candidates.some(value => value === null)) return undefined
  return projectCandidates(candidates as Candidate[])
}
