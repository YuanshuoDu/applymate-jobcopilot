import { TurnEngineError, type TurnEngineStep } from "./turn-engine-types.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import type pg from "pg"
import type { TurnLease } from "./lease.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { signalWasInterrupted } from "../interrupt/registry.js"
import { TASK_GRAPH_VERIFIER_VERSION, taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import { taskGraphItemId, type StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import { parseTaskGraphVerificationReport } from "../subagents/task-graph-command-port.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { validateRoleResult } from "../subagents/role-results.js"

type CompletionGateOptions = Pick<TurnExecutionOptions, "identity" | "scope" | "completionGate" | "isOwnershipLost">
type CompletionGateWriter = Pick<TurnExecutionEventWriter, "append">
export const TASK_GRAPH_VERIFICATION_BLOCKER = "task_graph_verification_unverified"
export const NATIVE_VERIFICATION_PENDING_BLOCKER = "native_verification_pending"
const TASK_GRAPH_FEEDBACK = "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing."
const REPAIR_SCHEMA = "agent-harness.v2.task-graph-repair-receipt.v1"
type GateCriterion = Readonly<{ criterionId: string; status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode }>
type GateReport = { status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode; criteria: readonly GateCriterion[]; unresolved: Set<string>; digest: string | null }
type GateFeedbackCode = "legacy_unverified" | "verification_report" | "repair_receipt" | "repair_criterion"
type RepairFeedbackState = "missing" | "pending" | "terminal" | "unavailable" | "missing_receipt" | "rejected" | "invalid_receipt" | "invalid_report"
type GateFeedbackDetail = Readonly<{ nodeOrdinal: number; criterionOrdinal?: number; status: "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode; repairState?: RepairFeedbackState }>
const ACTIVE_REPAIR_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const TERMINAL_REPAIR_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
function repairStatusFeedback(status: string): RepairFeedbackState {
  if (ACTIVE_REPAIR_STATUSES.has(status)) return "pending"
  if (status === "failed") return "rejected"
  if (TERMINAL_REPAIR_STATUSES.has(status)) return "terminal"
  return "unavailable"
}
export function repairReportState(task: { status: string; result: unknown } | undefined): RepairFeedbackState {
  if (!task) return "missing"
  if (ACTIVE_REPAIR_STATUSES.has(task.status)) return "pending"
  if (["completed", "interrupted", "cancelled", "closed"].includes(task.status)) return "terminal"
  if (task.status === "failed" && Object.hasOwn(row(task.result), "taskGraphVerificationReport")) return "invalid_report"
  return repairStatusFeedback(task.status)
}
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
  let feedback = TASK_GRAPH_FEEDBACK
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!, remaining = parts.length - index - 1
    const notice = remaining ? ` (${remaining} more feedback items omitted; inspect TaskGraph before retrying.)` : ""
    const next = `${feedback} ${part}${notice}`
    if (next.length > 512) {
      const omitted = ` (${parts.length - index} feedback items omitted; inspect TaskGraph before retrying.)`
      feedback += omitted
      break
    }
    feedback += ` ${part}`
  }
  return feedback
}
function row(value: unknown): Record<string, unknown> {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return {} } }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
function exactKeys(value: Record<string, unknown>, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function gateReport(node: StoredTaskGraphNode, result: unknown, role: string): GateReport | null {
  const stored = row(result), raw = stored.taskGraphVerificationReport, expected = node.verification?.criteria.map(item => item.id) ?? []
  if (node.verificationDisposition !== "typed" || !node.verification || role !== node.verification.role) return null
  const report = parseTaskGraphVerificationReport(raw, expected)
  let resultDigest: string | null = null
  try { if (Object.hasOwn(stored, "structuredResult")) resultDigest = taskGraphResultDigest(validateRoleResult(stored.structuredResult, role)) } catch { return null }
  if (!report || report.resultDigest !== resultDigest) return null
  if (report.reasonCode === "repair_target_unresolved") {
    if (!node.repairOf || report.status !== "unverified" || report.evidenceDigest !== null || !report.criteria.every(item => item.status === "passed")) return null
    return { status: "unverified", reasonCode: report.reasonCode, criteria: report.criteria, unresolved: new Set(node.repairOf.criterionIds), digest: null }
  }
  return { status: report.status, reasonCode: report.reasonCode, criteria: report.criteria, unresolved: new Set(report.criteria.filter(item => item.status !== "passed").map(item => item.criterionId)), digest: report.evidenceDigest }
}
function repairIds(node: StoredTaskGraphNode, result: unknown, target: StoredTaskGraphNode, report: GateReport): string[] | null {
  const relation = node.repairOf, receipt = row(row(result).taskGraphRepairReceipt), ids = relation?.criterionIds
  if (!relation || !ids?.length || !report.digest || receipt.schemaVersion !== REPAIR_SCHEMA || !exactKeys(receipt, "criterionIds,evidenceDigest,graphRootTaskId,repairNodeKey,repairTaskId,schemaVersion,targetNodeKey,targetTaskId,verifierVersion")
    || receipt.graphRootTaskId !== relation.graphRootTaskId || receipt.targetNodeKey !== target.key || receipt.targetTaskId !== target.taskId
    || receipt.repairNodeKey !== node.key || receipt.repairTaskId !== node.taskId || receipt.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION
    || receipt.evidenceDigest !== report.digest || !Array.isArray(receipt.criterionIds) || JSON.stringify(receipt.criterionIds) !== JSON.stringify(ids)) return null
  return [...ids]
}
/** Rechecks durable reports against the current immutable graph inside the caller's transaction. */
export async function checkTaskGraphTerminalVerification(client: pg.PoolClient, lease: TurnLease, rootTaskId: string, nativeVerificationPassed = false): Promise<Awaited<ReturnType<NonNullable<TurnExecutionOptions["completionGate"]>>>> {
  const deny = (code?: GateFeedbackCode, details: readonly GateFeedbackDetail[] = []) => ({ ok: false as const, blocker: TASK_GRAPH_VERIFICATION_BLOCKER, feedback: feedbackText(code, details) })
  const scope: GraphIdentityScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId, parentTaskId: rootTaskId }
  try {
    const loaded = await loadTaskGraph(client, scope, true)
    if (!loaded.snapshot) {
      const plans = await client.query(`SELECT 1 FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId" WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4 AND event."payload"->>'kind' IN ('proposal', 'native_command') AND session."userId" = $5 AND turn."userId" = $5 LIMIT 1`, [lease.sessionId, lease.turnId, taskGraphItemId(rootTaskId), rootTaskId, lease.userId])
      return plans.rows.length ? deny() : { ok: true }
    }
    const { nodes } = loaded.snapshot, reports = new Map<string, GateReport>()
    for (const node of nodes) {
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
    }
    for (const repair of nodes.filter(node => node.repairOf)) {
      const target = nodes.find(node => node.key === repair.repairOf?.nodeKey), report = reports.get(repair.taskId), task = loaded.tasks.get(repair.taskId)
      if (!target || target.taskId !== repair.repairOf?.taskId || repair.repairOf?.graphRootTaskId !== rootTaskId || !task || !report) return deny("repair_receipt", report ? reportFeedback(repair, report, nodes) : [])
      const hasReceipt = Object.hasOwn(row(task.result), "taskGraphRepairReceipt")
      if (task.status === "failed" && report.status !== "passed" && !hasReceipt && (task.failureReason === "task_graph_verification_" + report.status || report.reasonCode === "repair_target_unresolved" && task.failureReason === "task_graph_repair_target_unresolved")) continue
      if (report.status !== "passed" || task.status !== "completed" || task.failureReason !== null || !repairIds(repair, task.result, target, report)) {
        const targetReport = reports.get(target.taskId)
        return deny("repair_receipt", [...(targetReport ? reportFeedback(target, targetReport, nodes, "invalid_receipt") : []), ...reportFeedback(repair, report, nodes)])
      }
    }
    return { ok: true }
  } catch { return deny() }
}

export async function assertCompletionAllowed(options: CompletionGateOptions, writer: CompletionGateWriter, step: TurnEngineStep, signal: AbortSignal, now: () => Date, candidateText: string): Promise<{ feedback: string } | { waitId: string } | undefined> {
  if (!options.completionGate) return undefined
  let decision: Awaited<ReturnType<NonNullable<TurnExecutionOptions["completionGate"]>>>
  try {
    decision = await options.completionGate({ identity: options.identity, scope: options.scope, rootTaskId: options.identity.rootTaskId, stepId: step.id, candidateText, signal, now: now() })
  } catch (error: unknown) {
    if (isSessionPauseRequestedError(error) || signalWasInterrupted(signal) || signal.aborted || options.isOwnershipLost?.(error, signal)) throw error
    throw new TurnEngineError("invalid_output", "Completion gate failed closed")
  }
  if (!decision || typeof decision !== "object" || typeof decision.ok !== "boolean") throw new TurnEngineError("invalid_output", "Completion gate returned an invalid decision")
  if (decision.ok) return undefined
  if (typeof decision.blocker !== "string" || typeof decision.feedback !== "string" || decision.blocker.length === 0 || decision.blocker.length > 256 || decision.feedback.length > 512) {
    throw new TurnEngineError("invalid_output", "Completion gate returned an invalid blocker")
  }
  if (decision.waitId !== undefined) {
    if (decision.blocker !== NATIVE_VERIFICATION_PENDING_BLOCKER || typeof decision.waitId !== "string" || !decision.waitId.trim() || decision.waitId.length > 128) {
      throw new TurnEngineError("invalid_output", "Completion gate returned an invalid wait")
    }
    return { waitId: decision.waitId }
  }
  if (decision.blocker === NATIVE_VERIFICATION_PENDING_BLOCKER) throw new TurnEngineError("invalid_output", "Completion gate omitted a durable wait receipt")
  await writer.append("final.rejected", step.id, null, { code: "business_precondition_failed", blocker: decision.blocker, feedback: decision.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}`)
  if (decision.blocker === TASK_GRAPH_VERIFICATION_BLOCKER) return { feedback: decision.feedback }
  throw new TurnEngineError("business_precondition_failed", decision.blocker)
}

export function taskGraphGateRecovery(error: unknown): { feedback: string } | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as Record<string, unknown>
  return value.name === "TaskGraphVerificationRecovery" && value.blocker === TASK_GRAPH_VERIFICATION_BLOCKER
    && typeof value.feedback === "string" && value.feedback.length > 0 && value.feedback.length <= 512 ? { feedback: value.feedback } : undefined
}
