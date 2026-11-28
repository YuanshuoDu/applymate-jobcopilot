import type { RootTaskVerificationRequirement } from "../context/root-task-objective.js"
import type { TaskGraphObjectiveRequirementLineagesSelection, TaskGraphObjectiveLineageCriterion } from "../planning/task-graph-objective-lineage.js"
import { resolveRootTaskVerificationRequirements } from "../context/root-task-objective.js"
import { selectTaskGraphObjectiveRequirementLineages } from "../planning/task-graph-objective-lineage.js"
import type pg from "pg"
import type { TurnLease } from "./lease.js"
import type { GraphTaskRow } from "../subagents/task-graph-pg-state.js"
import { validateRoleResult } from "../subagents/role-results.js"
import type { StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import { taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { repairIds, type GateReport } from "./task-graph-terminal-assessment.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_FEEDBACK } from "./turn-execution-terminal-decision.js"

export type TaskGraphObjectiveFindingAggregation =
  | Readonly<{ status: "not_applicable" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "satisfied"; criterionId: string; required: number; observed: number }>
  | Readonly<{ status: "shortfall"; criterionId: string; required: number; observed: number }>

export type TaskGraphGateFeedbackCode = "legacy_unverified" | "verification_report" | "repair_receipt" | "repair_criterion" | "result_applicability" | "finding_count_shortfall"
export type TaskGraphGateRepairState = "missing" | "pending" | "terminal" | "unavailable" | "missing_receipt" | "rejected" | "invalid_receipt" | "invalid_report"
export type TaskGraphGateFeedbackDetail = Readonly<{ nodeOrdinal: number; criterionOrdinal?: number; status: "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode; repairState?: TaskGraphGateRepairState }>
export type TaskGraphGateFeedbackCounts = Readonly<{ criterionId: string; required: number; observed: number }>

export function taskGraphGateFeedbackText(code: TaskGraphGateFeedbackCode | undefined, details: readonly TaskGraphGateFeedbackDetail[], counts?: TaskGraphGateFeedbackCounts): string {
  const rendered = details.map(item => {
    const criterion = item.criterionOrdinal === undefined ? "" : ` criterionOrdinal=${item.criterionOrdinal}`
    const repair = item.repairState ? ` repair=${item.repairState}` : ""
    return `nodeOrdinal=${item.nodeOrdinal}${criterion} status=${item.status} reasonCode=${item.reasonCode}${repair}`
  })
  const parts = [...(code ? [`issue=${code}`] : []), ...(counts ? [`required=${counts.required} observed=${counts.observed}`, `criterionId=${counts.criterionId}`] : []), ...rendered]
  const render = (included: number) => `${TASK_GRAPH_FEEDBACK}${parts.slice(0, included).map(part => ` ${part}`).join("")}`
  const complete = render(parts.length)
  if (complete.length <= 512) return complete
  for (let included = parts.length - 1; included >= 0; included -= 1) {
    const omitted = ` (${parts.length - included} feedback items omitted; inspect TaskGraph before retrying.)`
    const truncated = `${render(included)}${omitted}`
    if (truncated.length <= 512) return truncated
  }
  return `${TASK_GRAPH_FEEDBACK} (${parts.length} feedback items omitted; inspect TaskGraph before retrying.)`
}

type Lineage = Readonly<{ node: StoredTaskGraphNode; criterion: TaskGraphObjectiveLineageCriterion }>
type LineageSelection = TaskGraphObjectiveRequirementLineagesSelection<StoredTaskGraphNode>

function validCriterion(lineage: Lineage, requirement: RootTaskVerificationRequirement): boolean {
  const check = lineage.criterion.check
  return requirement.kind === "finding_count_gte" && lineage.criterion.id === requirement.id
    && check.kind === "finding_count_gte" && Number.isSafeInteger(check.minimum) && check.minimum > 0
    && lineage.node.verificationDisposition === "typed" && lineage.node.verification?.role === "analyst"
}

function record(value: unknown): Record<string, unknown> | null {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null
  } catch { return null }
}

function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }

function checkedFindings(input: Readonly<{
  lineage: Lineage
  requirement: RootTaskVerificationRequirement
  fullNodes: readonly StoredTaskGraphNode[]
  tasks: ReadonlyMap<string, GraphTaskRow>
  reports: ReadonlyMap<string, GateReport>
  rootTaskId: string
}>): readonly string[] | null {
  const { lineage, requirement, fullNodes, tasks, reports, rootTaskId } = input
  if (!validCriterion(lineage, requirement)) return null
  const check = lineage.criterion.check
  if (check.kind !== "finding_count_gte") return null
  const taskId = lineage.node.taskId, task = tasks.get(taskId), report = reports.get(taskId)
  if (!task || task.id !== taskId || task.role !== "analyst" || task.status !== "completed" || task.failureReason !== null
    || !report || report.status !== "passed" || !digest(report.digest) || !digest(report.resultDigest)) return null
  const stored = record(task.result), structured = stored && Object.hasOwn(stored, "structuredResult") ? stored.structuredResult : undefined
  let result: ReturnType<typeof validateRoleResult>
  try { result = validateRoleResult(structured, "analyst") } catch { return null }
  if (result.role !== "analyst" || result.status !== "completed" || taskGraphResultDigest(result) !== report.resultDigest
    || result.findings.length < check.minimum
    || !report.criteria.some(item => item.criterionId === requirement.id && item.status === "passed")) return null
  if (lineage.node.repairOf) {
    const relation = lineage.node.repairOf
    const target = fullNodes.find(node => node.key === relation.nodeKey)
    if (!target || relation.graphRootTaskId !== rootTaskId || relation.taskId !== target.taskId
      || !repairIds(lineage.node, task.result, target, report)) return null
  }
  return result.findings.map(finding => finding.jobId)
}

/** Aggregates only the current members of a requirement that was split in the full graph. */
export function aggregateTaskGraphObjectiveFindings(input: Readonly<{
  requirement: RootTaskVerificationRequirement
  full: LineageSelection
  applicableTaskIds: ReadonlySet<string>
  fullNodes: readonly StoredTaskGraphNode[]
  tasks: ReadonlyMap<string, GraphTaskRow>
  reports: ReadonlyMap<string, GateReport>
  rootTaskId: string
}>): TaskGraphObjectiveFindingAggregation {
  const { requirement, full, applicableTaskIds, fullNodes, tasks, reports, rootTaskId } = input
  if (requirement.kind !== "finding_count_gte") return { status: "not_applicable" }
  if (full.status === "missing") return { status: "not_applicable" }
  if (full.status !== "selected"
    || !Number.isSafeInteger(requirement.minimum) || requirement.minimum < 1) return { status: "invalid" }
  if (full.lineages.length < 2) return { status: "not_applicable" }
  if (full.lineages.some(lineage => !validCriterion(lineage, requirement))
    || new Set(full.lineages.map(lineage => lineage.node.key)).size !== full.lineages.length
    || full.lineages.reduce((sum, lineage) => sum + (lineage.criterion.check.kind === "finding_count_gte" ? lineage.criterion.check.minimum : 0), 0) < requirement.minimum) return { status: "invalid" }
  const current = full.lineages.filter(lineage => applicableTaskIds.has(lineage.node.taskId))
  if (current.some(lineage => !validCriterion(lineage, requirement))
    || new Set(current.map(lineage => lineage.node.key)).size !== current.length) return { status: "invalid" }
  const observedIds = new Set<string>()
  for (const lineage of current) {
    const findings = checkedFindings({ lineage, requirement, fullNodes, tasks, reports, rootTaskId })
    if (!findings) return { status: "invalid" }
    for (const jobId of findings) observedIds.add(jobId)
  }
  const observed = observedIds.size
  return observed >= requirement.minimum
    ? { status: "satisfied", criterionId: requirement.id, required: requirement.minimum, observed }
    : { status: "shortfall", criterionId: requirement.id, required: requirement.minimum, observed }
}

function candidateFindingIds(nodes: readonly StoredTaskGraphNode[], rootTaskId: string): Set<string> {
  const candidates = new Map<string, number>()
  for (const node of nodes) {
    if (node.verificationDisposition !== "typed" || node.verification?.role !== "analyst") continue
    for (const criterion of node.verification.criteria) if (criterion.check.kind === "finding_count_gte") {
      candidates.set(criterion.id, (candidates.get(criterion.id) ?? 0) + 1)
    }
  }
  const split = new Set<string>()
  for (const [id, occurrences] of candidates) {
    if (occurrences < 2) continue
    const selection = selectTaskGraphObjectiveRequirementLineages({ id, kind: "finding_count_gte", minimum: 1 }, nodes, rootTaskId)
    if (selection.status === "invalid" || selection.status === "selected" && selection.lineages.length > 1) split.add(id)
  }
  return split
}

/** Reads the immutable user requirement only after an in-memory split candidate exists. */
export async function verifyTaskGraphObjectiveFindingAggregation(input: Readonly<{
  client: Pick<pg.PoolClient, "query">
  lease: TurnLease
  rootTaskId: string
  fullNodes: readonly StoredTaskGraphNode[]
  applicableTaskIds: ReadonlySet<string>
  tasks: ReadonlyMap<string, GraphTaskRow>
  reports: ReadonlyMap<string, GateReport>
  discoveryTurnEligibility?: "ordinary" | "scheduled" | "unknown"
}>): Promise<TaskGraphObjectiveFindingAggregation> {
  const candidates = candidateFindingIds(input.fullNodes, input.rootTaskId)
  if (!candidates.size || input.discoveryTurnEligibility !== "ordinary") return { status: "not_applicable" }
  const { lease, rootTaskId } = input
  const turn = await input.client.query<{ input: unknown }>(`SELECT turn."input" FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = $3
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph' AND turn."status" = 'in_progress'
      AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6`,
  [lease.turnId, lease.sessionId, lease.userId, rootTaskId, lease.ownerId, lease.leaseVersion])
  if (!turn.rows[0]) return { status: "invalid" }
  const requirements = resolveRootTaskVerificationRequirements(turn.rows[0].input)
  if (requirements.status === "absent") return { status: "not_applicable" }
  if (requirements.status !== "valid") return { status: "invalid" }
  let satisfied: Extract<TaskGraphObjectiveFindingAggregation, { status: "satisfied" }> | undefined
  for (const requirement of requirements.requirements) {
    if (requirement.kind !== "finding_count_gte" || !candidates.has(requirement.id)) continue
    const full = selectTaskGraphObjectiveRequirementLineages(requirement, input.fullNodes, rootTaskId)
    const result = aggregateTaskGraphObjectiveFindings({ ...input, requirement, full, rootTaskId })
    if (result.status === "invalid" || result.status === "shortfall") return result
    if (result.status === "satisfied") satisfied = result
  }
  return satisfied ?? { status: "not_applicable" }
}
