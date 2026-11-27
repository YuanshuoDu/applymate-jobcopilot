import { TASK_GRAPH_DENIAL_CHECKPOINT, type TurnExecutionOptions } from "./turn-execution-types.js"
import type pg from "pg"
import { OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE } from "@jobcopilot/agent-protocol"
import type { TurnLease } from "./lease.js"
import { loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import { taskGraphItemId, type StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { buildTaskGraphDenialCheckpoint, gateReport, projectVerifiedCompletedTaskIds, repairIds, repairReportState, repairStatusFeedback,
  type GateReport, type RepairFeedbackState, type TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import { STEERING_RECONCILIATION_BLOCKER, STEERING_RECONCILIATION_EVENT_TYPE, STEERING_RECONCILIATION_FEEDBACK,
  type SteeringReconciliationState } from "../subagents/steering-reconciliation-contract.js"
import { readSteeringReconciliationState } from "../subagents/steering-reconciliation-read.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { applyCompletionRecovery, TASK_GRAPH_RECOVERY_REVISION } from "./completion-recovery-context.js"
import { buildTaskGraphFinalSummaryBinding, TASK_GRAPH_FINAL_SUMMARY_BINDING } from "../subagents/task-graph-final-summary-binding.js"
import { readTaskGraphConfirmedLocationSteer } from "../subagents/task-graph-confirmed-location-steer.js"
import { resolveTaskGraphConfirmedLocationCompletion } from "./task-graph-confirmed-location-completion.js"
import { taskGraphCompletionApplicability } from "./task-graph-completion-applicability.js"
import { readTaskGraphRetiredScouts } from "./task-graph-retirement-completion.js"
import { assertCompletionAllowed, TASK_GRAPH_FEEDBACK, TASK_GRAPH_VERIFICATION_BLOCKER } from "./turn-execution-terminal-decision.js"
export { assertCompletionAllowed, TASK_GRAPH_VERIFICATION_BLOCKER }
export { repairReportState }

export function completionRecoverySnapshot(snapshot: StepContextSnapshot, stepId: string, feedback: string): StepContextSnapshot {
  return applyCompletionRecovery(snapshot, stepId, feedback)
}
type GateFeedbackCode = "legacy_unverified" | "verification_report" | "repair_receipt" | "repair_criterion" | "result_applicability"
type GateFeedbackDetail = Readonly<{ nodeOrdinal: number; criterionOrdinal?: number; status: "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode; repairState?: RepairFeedbackState }>
function reportFeedback(node: StoredTaskGraphNode, report: GateReport, nodes: readonly StoredTaskGraphNode[], repairState?: RepairFeedbackState): GateFeedbackDetail[] {
  const nodeIndex = nodes.findIndex(candidate => candidate.taskId === node.taskId)
  if (nodeIndex < 0) return []
  const details: GateFeedbackDetail[] = []
  for (const item of report.criteria) if (item.status !== "passed") {
    const criterionIndex = node.verification?.criteria.findIndex(criterion => criterion.id === item.criterionId) ?? -1
    if (criterionIndex >= 0) details.push({ nodeOrdinal: nodeIndex + 1, criterionOrdinal: criterionIndex + 1, status: item.status, reasonCode: item.reasonCode, repairState })
  }
  return details.length ? details : report.reasonCode === "repair_target_unresolved"
    ? [{ nodeOrdinal: nodeIndex + 1, status: "unverified", reasonCode: report.reasonCode, repairState }]
    : []
}
function feedbackText(code: GateFeedbackCode | undefined, details: readonly GateFeedbackDetail[]): string {
  const rendered = details.map(item => {
    const criterion = item.criterionOrdinal === undefined ? "" : ` criterionOrdinal=${item.criterionOrdinal}`
    const repair = item.repairState ? ` repair=${item.repairState}` : ""
    return `nodeOrdinal=${item.nodeOrdinal}${criterion} status=${item.status} reasonCode=${item.reasonCode}${repair}`
  })
  const parts = [...(code ? [`issue=${code}`] : []), ...rendered]
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
function row(value: unknown): Record<string, unknown> {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return {} } }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
async function hasReconciliationEventHint(client: pg.PoolClient, lease: TurnLease, rootTaskId: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3 AND event."type" = $4
      AND turn."rootTaskId" = $3 AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6
      AND session."userId" = $7 AND turn."userId" = $7 AND to_jsonb(turn)->>'source' = 'user' LIMIT 1`,
  [lease.sessionId, lease.turnId, rootTaskId, STEERING_RECONCILIATION_EVENT_TYPE, lease.ownerId, lease.leaseVersion, lease.userId])
  return result.rows.length > 0
}
async function hasConfirmedLocationEventHint(client: pg.PoolClient, lease: TurnLease, rootTaskId: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $4
      AND turn."rootTaskId" = $3 AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6
      AND session."userId" = $7 AND turn."userId" = $7 LIMIT 1`,
  [lease.sessionId, lease.turnId, rootTaskId, OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, lease.ownerId, lease.leaseVersion, lease.userId])
  return result.rows.length > 0
}
async function readPersistedTurnInput(client: pg.PoolClient, lease: TurnLease, rootTaskId: string): Promise<{ found: boolean; input?: unknown }> {
  const result = await client.query(`SELECT turn."input" FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND turn."status" = 'in_progress' LIMIT 2`,
  [lease.turnId, lease.sessionId, lease.userId, rootTaskId, lease.ownerId, lease.leaseVersion])
  return result.rows.length === 1 ? { found: true, input: result.rows[0]?.input } : { found: false }
}
/** Rechecks durable reports against the current immutable graph inside the caller's transaction. */
export async function checkTaskGraphTerminalVerification(client: pg.PoolClient, lease: TurnLease, rootTaskId: string, nativeVerificationPassed = false, requireTaskGraph = false): Promise<Awaited<ReturnType<NonNullable<TurnExecutionOptions["completionGate"]>>>> {
  let graphRevision: number | null = null
  let denialCheckpoint: TaskGraphDenialCheckpoint | null = null
  const deny = (code?: GateFeedbackCode, details: readonly GateFeedbackDetail[] = []) => {
    const decision = { ok: false as const, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: feedbackText(code, details) }
    if (graphRevision !== null) Object.defineProperty(decision, TASK_GRAPH_RECOVERY_REVISION, { value: graphRevision, enumerable: true })
    if (denialCheckpoint) Object.defineProperty(decision, TASK_GRAPH_DENIAL_CHECKPOINT, { value: denialCheckpoint })
    return decision
  }
  const scope: GraphIdentityScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId, parentTaskId: rootTaskId }
  try {
    let reconciliationState: SteeringReconciliationState | null = null
    const hasRevisionHint = await hasReconciliationEventHint(client, lease, rootTaskId)
    const hasLocationHint = await hasConfirmedLocationEventHint(client, lease, rootTaskId)
    if (hasRevisionHint || hasLocationHint) {
      reconciliationState = await readSteeringReconciliationState(client, { ...scope, turnLeaseOwner: lease.ownerId,
        turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: 1 })
      if (reconciliationState.unresolvedInputs.length) return { ok: false, blocker: STEERING_RECONCILIATION_BLOCKER, feedback: STEERING_RECONCILIATION_FEEDBACK }
    }
    let confirmedLocation: Awaited<ReturnType<typeof readTaskGraphConfirmedLocationSteer>> | null = null
    if (hasLocationHint) {
      const cutoff = reconciliationState?.lastReconciledInputThroughSequence
      if (typeof cutoff !== "bigint" || cutoff < 0n) return deny("result_applicability")
      confirmedLocation = await readTaskGraphConfirmedLocationSteer(client, {
        userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId,
      }, cutoff)
      if (confirmedLocation.kind === "pending") return { ok: false, blocker: STEERING_RECONCILIATION_BLOCKER, feedback: STEERING_RECONCILIATION_FEEDBACK }
      if (confirmedLocation.kind === "unavailable" || confirmedLocation.kind === "absent") return deny("result_applicability")
    }
    const latestUserRevision = reconciliationState?.latestUserRevision
    const loaded = await loadTaskGraph(client, scope, true, latestUserRevision || confirmedLocation?.kind === "confirmed" ? { includeSourceProvenance: true } : {})
    if (!loaded.snapshot) {
      if (latestUserRevision || confirmedLocation?.kind === "confirmed") return deny("result_applicability")
      const plans = await client.query(`SELECT 1 FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId" WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4 AND event."payload"->>'kind' IN ('proposal', 'native_command') AND session."userId" = $5 AND turn."userId" = $5 LIMIT 1`, [lease.sessionId, lease.turnId, taskGraphItemId(rootTaskId), rootTaskId, lease.userId])
      return plans.rows.length || requireTaskGraph ? deny() : { ok: true }
    }
    if ((latestUserRevision || confirmedLocation?.kind === "confirmed")
      && (!loaded.item || reconciliationState?.currentRevision !== loaded.item.revision)) return deny("result_applicability")
    if (requireTaskGraph && loaded.snapshot.nodes.length === 0) return deny()
    graphRevision = loaded.item && Number.isSafeInteger(loaded.item.revision) && loaded.item.revision >= 1 ? loaded.item.revision : null
    denialCheckpoint = buildTaskGraphDenialCheckpoint(loaded, rootTaskId)
    const { nodes } = loaded.snapshot, reports = new Map<string, GateReport>(), resolvedRepairTaskIds = new Set<string>()
    const resolvedTargetCriteria = new Map<string, ReadonlySet<string>>()
    const retiredScouts = latestUserRevision ? await readTaskGraphRetiredScouts(client, scope, loaded, reconciliationState!) : new Map()
    const retiredNodeKeys = new Set(retiredScouts.keys())
    for (const node of nodes) {
      if (retiredNodeKeys.has(node.key)) continue
      if (node.verificationDisposition === "legacy_unverified" && !(nativeVerificationPassed && node.nativeDelegation)) return deny("legacy_unverified")
      if (node.verificationDisposition !== "typed") continue
      const task = loaded.tasks.get(node.taskId), report = gateReport(node, task?.result, task?.role ?? "")
      if (!task || task.role !== node.verification?.role || !report) {
        const target = node.repairOf ? nodes.find(candidate => candidate.key === node.repairOf?.nodeKey) : undefined
        const targetTask = target ? loaded.tasks.get(target.taskId) : undefined
        const targetReport = target && targetTask ? gateReport(target, targetTask.result, targetTask.role ?? "") : null
        const repairState = node.repairOf ? repairReportState(task) : undefined
        return deny("verification_report", target && targetReport ? reportFeedback(target, targetReport, nodes, repairState) : [])
      }
      reports.set(node.taskId, report)
      if (node.repairOf) continue
      if (report.status === "passed" ? task.status !== "completed" || task.failureReason !== null
        : task.status !== "failed" || task.failureReason !== "task_graph_verification_" + report.status) return deny("verification_report", reportFeedback(node, report, nodes))
    }
    for (const target of nodes.filter(node => node.verificationDisposition === "typed" && !node.repairOf)) {
      if (retiredNodeKeys.has(target.key)) continue
      const original = reports.get(target.taskId)!
      if (original.status === "passed") continue
      const counts = new Map<string, number>(), repairDetails: GateFeedbackDetail[] = []
      for (const repair of nodes.filter(node => node.repairOf?.graphRootTaskId === rootTaskId && node.repairOf.taskId === target.taskId && node.repairOf.nodeKey === target.key)) {
        const task = loaded.tasks.get(repair.taskId), report = reports.get(repair.taskId), stored = row(task?.result), hasReceipt = Object.hasOwn(stored, "taskGraphRepairReceipt")
        if (!task || !report || !repairIds(repair, task.result, target, report) || report.status !== "passed" || task.status !== "completed" || task.failureReason !== null) {
          const repairState = !report ? repairReportState(task) : hasReceipt ? "invalid_receipt" : task?.status === "completed" ? "missing_receipt" : task ? repairStatusFeedback(task.status) : "missing"
          repairDetails.push(...(report ? reportFeedback(repair, report, nodes) : []), ...reportFeedback(target, original, nodes, repairState))
          if (hasReceipt || task?.status === "completed") return deny("repair_receipt", repairDetails)
          continue
        }
        for (const id of repair.repairOf!.criterionIds) {
          if (!original.unresolved.has(id)) return deny("repair_criterion", [...reportFeedback(target, original, nodes, "invalid_receipt"), ...reportFeedback(repair, report, nodes)])
          counts.set(id, (counts.get(id) ?? 0) + 1)
        }
      }
      const unresolved = [...original.unresolved].filter(id => counts.get(id) !== 1)
      if (unresolved.length) return deny("repair_receipt", [...(repairDetails.length ? [] : reportFeedback(target, original, nodes, "missing")), ...repairDetails])
      if (original.unresolved.size) {
        resolvedRepairTaskIds.add(target.taskId)
        resolvedTargetCriteria.set(target.taskId, new Set(original.unresolved))
      }
    }
    for (const repair of nodes.filter(node => node.repairOf)) {
      const target = nodes.find(node => node.key === repair.repairOf?.nodeKey), report = reports.get(repair.taskId), task = loaded.tasks.get(repair.taskId)
      if (!target || target.taskId !== repair.repairOf?.taskId || repair.repairOf?.graphRootTaskId !== rootTaskId || !task || !report) return deny("repair_receipt", report ? reportFeedback(repair, report, nodes) : [])
      const hasReceipt = Object.hasOwn(row(task.result), "taskGraphRepairReceipt")
      if (task.status === "failed" && report.status !== "passed" && !hasReceipt && (task.failureReason === "task_graph_verification_" + report.status || report.reasonCode === "repair_target_unresolved" && task.failureReason === "task_graph_repair_target_unresolved")) {
        const criteria = repair.repairOf!.criterionIds, resolved = resolvedTargetCriteria.get(target.taskId)
        if (resolved && criteria.length > 0 && new Set(criteria).size === criteria.length && criteria.every(id => resolved.has(id))) resolvedRepairTaskIds.add(repair.taskId)
        continue
      }
      if (report.status !== "passed" || task.status !== "completed" || task.failureReason !== null || !repairIds(repair, task.result, target, report)) {
        const targetReport = reports.get(target.taskId)
        return deny("repair_receipt", [...(targetReport ? reportFeedback(target, targetReport, nodes, "invalid_receipt") : []), ...reportFeedback(repair, report, nodes)])
      }
    }
    const verifiedCompletedTaskIds = projectVerifiedCompletedTaskIds(reports, loaded.tasks)
    let historicalNodeIndices: ReadonlySet<number> = new Set()
    if (confirmedLocation?.kind === "confirmed") {
      const persisted = await readPersistedTurnInput(client, lease, rootTaskId)
      if (!persisted.found) return deny("result_applicability")
      const locationCompletion = await resolveTaskGraphConfirmedLocationCompletion({
        client, loaded, scope, reconciliation: reconciliationState!, confirmed: confirmedLocation,
        persistedTurnInput: persisted.input, verifiedCompletedTaskIds, retiredNodeKeys,
      })
      if (locationCompletion.kind === "pending") return { ok: false, blocker: STEERING_RECONCILIATION_BLOCKER, feedback: STEERING_RECONCILIATION_FEEDBACK }
      if (locationCompletion.kind !== "applicable") return deny("result_applicability")
      historicalNodeIndices = locationCompletion.historicalNodeIndices
    }
    if (latestUserRevision && confirmedLocation?.kind !== "confirmed") {
      const applicability = taskGraphCompletionApplicability(loaded, latestUserRevision, reconciliationState!.currentRevision,
        verifiedCompletedTaskIds, undefined, retiredNodeKeys)
      if (applicability.kind === "replan") return deny("result_applicability")
      historicalNodeIndices = applicability.historicalNodeIndices
    }
    const binding = buildTaskGraphFinalSummaryBinding(loaded, historicalNodeIndices, resolvedRepairTaskIds, retiredScouts)
    if (!binding && retiredScouts.size > 0) return deny("result_applicability")
    return binding ? { ok: true, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding } : { ok: true }
  } catch { graphRevision = null; denialCheckpoint = null; return deny() }
}

export function taskGraphGateRecovery(error: unknown): { feedback: string } | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as Record<string, unknown>
  return value.name === "TaskGraphVerificationRecovery" && value.blocker === TASK_GRAPH_VERIFICATION_BLOCKER
    && typeof value.feedback === "string" && value.feedback.length > 0 && value.feedback.length <= 512 ? { feedback: value.feedback } : undefined
}

export function steeringReconciliationRecoveryError(): Error & Readonly<{ code: string; blocker: string; feedback: string }> {
  return Object.assign(new Error(STEERING_RECONCILIATION_BLOCKER), {
    name: "SteeringReconciliationRecovery", code: STEERING_RECONCILIATION_BLOCKER,
    blocker: STEERING_RECONCILIATION_BLOCKER, feedback: STEERING_RECONCILIATION_FEEDBACK,
  })
}

export function steeringReconciliationGateRecovery(error: unknown): { feedback: string } | undefined {
  if (!(error instanceof Error) || error.name !== "SteeringReconciliationRecovery" || error.message !== STEERING_RECONCILIATION_BLOCKER) return undefined
  const value = error as Error & { code?: unknown; blocker?: unknown; feedback?: unknown }
  return value.code === STEERING_RECONCILIATION_BLOCKER && value.blocker === STEERING_RECONCILIATION_BLOCKER
    && value.feedback === STEERING_RECONCILIATION_FEEDBACK ? { feedback: STEERING_RECONCILIATION_FEEDBACK } : undefined
}
