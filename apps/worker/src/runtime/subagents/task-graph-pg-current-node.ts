import { redactSensitiveText } from "@jobcopilot/shared"
import { deriveTaskGraphReadModel } from "../planning/task-graph.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus,
  type TaskGraphCurrentNode, type TaskGraphCurrentState } from "./task-graph-command-port.js"
import { classifyTaskGraphStructuredOutputFailure } from "./task-graph-structured-failure-category.js"
import { taskGraphNativeCurrentView } from "./task-graph-native-result.js"
import { projectTaskGraphResult, taskGraphResultProjectionBytes, taskGraphResultProjectionItemCount,
  TASK_GRAPH_RESULT_PROJECTION_ITEMS_TOTAL, TASK_GRAPH_RESULT_PROJECTION_TOTAL_BYTE_LIMIT } from "./task-graph-result-projection.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import { projectTaskGraphDiscoveryAttemptHealth, projectTaskGraphDiscoveryAttemptQueryFootprint,
  type TaskGraphDiscoveryTurnEligibility } from "./task-graph-discovery-attempt-health.js"
import { SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"
import { isScheduledTaskGraphSpecializedEnvelope } from "./task-graph-pg-specialized-envelope.js"
import type { DiscoveryQueryFootprint } from "./child-discovery-query-footprint.js"

export function currentTaskGraph(loaded: LoadedGraph): TaskGraphCurrentState {
  if (!loaded.state || !loaded.snapshot) return { revision: 0, nodes: [] }
  const read = deriveTaskGraphReadModel(loaded.state)
  const taskByKey = new Map(loaded.snapshot.nodes.map(node => [node.key, loaded.tasks.get(node.taskId)!] as const))
  let projectionBytes = 0
  let projectionItems = 0
  let hasOrdinaryQueryFootprint = false
  const turn = loaded.discoveryTurnEligibility ?? "unknown"
  const nodes: TaskGraphCurrentNode[] = read.map(node => {
    const task = taskByKey.get(node.key)!
    const stored = loaded.snapshot!.nodes.find(candidate => candidate.key === node.key)!
    const verification = stored.verificationDisposition === "typed" ? stored.verification : undefined,
      verificationCriterionIds = verification?.criteria.map(criterion => criterion.id), taskResult = parseObject(task.result)
    const hasReport = Boolean(taskResult && Object.hasOwn(taskResult, "taskGraphVerificationReport")), verificationReport = verificationCriterionIds
      ? parseTaskGraphVerificationReport(taskResult?.taskGraphVerificationReport, verificationCriterionIds) : undefined
    const specializedEnvelope = isScheduledTaskGraphSpecializedEnvelope({ snapshot: loaded.snapshot, tasks: loaded.tasks, node: stored, task })
    const gateEnvelope = specializedEnvelope === "gate"
    if (stored.templateId === SCHEDULED_GATE_TEMPLATE_ID && (task.status === "waiting_for_user" || task.status === "completed") && !gateEnvelope) {
      throw new Error("task_graph_verification_report_invalid")
    }
    if (stored.templateId === SCHEDULED_AUDIT_TEMPLATE_ID && task.status === "completed" && specializedEnvelope !== "audit") {
      throw new Error("task_graph_verification_report_invalid")
    }
    const repairOf = stored.repairOf?.graphRootTaskId === loaded.rootTaskId ? stored.repairOf : undefined
    const hasReceipt = Boolean(taskResult && Object.hasOwn(taskResult, "taskGraphRepairReceipt"))
    const repairReceipt = parseTaskGraphRepairReceipt(taskResult?.taskGraphRepairReceipt, {
      repairOf, repairNodeKey: stored.key, repairTaskId: stored.taskId, report: verificationReport,
    })
    if (hasReport && specializedEnvelope === null && (!verificationReport || !taskGraphVerificationReportMatchesStatus(verificationReport, task.status)
      || verificationReport.reasonCode === "repair_target_unresolved" && !repairOf)
      || stored.verificationDisposition === "typed" && (task.status === "completed" || task.status === "failed") && !verificationReport
      || hasReceipt && !repairReceipt
      || stored.repairOf && task.status === "completed" && verificationReport?.status === "passed" && !repairReceipt) throw new Error("task_graph_verification_report_invalid")
    const structuredOutputFailureCategory = classifyTaskGraphStructuredOutputFailure({ snapshotNode: stored, task, verificationReport, hasRepairReceipt: Boolean(repairReceipt) }), discoveryAttemptHealth = projectTaskGraphDiscoveryAttemptHealth(stored, task, taskResult)
    let discoveryQueryFootprint: DiscoveryQueryFootprint | undefined
    try { discoveryQueryFootprint = projectTaskGraphDiscoveryAttemptQueryFootprint(stored, task, task.result, turn) } catch { discoveryQueryFootprint = undefined }
    if (discoveryQueryFootprint) hasOrdinaryQueryFootprint = true
    const projectionSource = taskGraphProjectionSource(task.result, taskResult, Boolean(verificationReport), Boolean(repairReceipt))
    const proposedProjection = projectTaskGraphResult(task.role, task.status, projectionSource)
    const bytes = taskGraphResultProjectionBytes(proposedProjection)
    const items = taskGraphResultProjectionItemCount(proposedProjection)
    const projectionFits = projectionBytes + bytes <= TASK_GRAPH_RESULT_PROJECTION_TOTAL_BYTE_LIMIT
      && projectionItems + items <= TASK_GRAPH_RESULT_PROJECTION_ITEMS_TOTAL
    const resultProjection = projectionFits ? proposedProjection : projectTaskGraphResult("", "", null)
    if (projectionFits) {
      projectionBytes += bytes
      projectionItems += items
    }
    return {
      key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria,
      dependsOn: node.dependsOn, taskId: stored.taskId,
      status: task.status, readiness: node.readiness, resultSummary: resultSummary(task.result),
      resultProjection, ...(discoveryAttemptHealth ? { discoveryAttemptHealth } : {}),
      ...(discoveryQueryFootprint ? { discoveryQueryFootprint } : {}),
      ...(verification ? { verification } : {}), ...(verificationCriterionIds ? { verificationCriterionIds } : {}),
      ...(verificationReport ? { verificationReport } : {}),
      ...(repairOf ? { repairOf } : {}), ...(repairReceipt ? { repairReceipt } : {}),
      ...(stored.nativeDelegation ? taskGraphNativeCurrentView(stored.nativeDelegation, task) : {}),
      failureReason: safeText(task.failureReason, 500), ...(structuredOutputFailureCategory ? { structuredOutputFailureCategory } : {}),
    }
  })
  return { revision: loaded.state.revision, nodes, ...(hasOrdinaryQueryFootprint ? { discoveryTurnEligibility: "ordinary" } : {}) }
}

function taskGraphProjectionSource(
  original: unknown,
  result: Record<string, unknown> | null,
  hasValidatedReport: boolean,
  hasValidatedReceipt: boolean,
): unknown {
  if (!result || (!hasValidatedReport && !hasValidatedReceipt)) return original
  const copy = Object.create(Object.getPrototypeOf(result)) as Record<PropertyKey, unknown>
  for (const key of Reflect.ownKeys(result)) {
    if ((hasValidatedReport && key === "taskGraphVerificationReport") || (hasValidatedReceipt && key === "taskGraphRepairReceipt")) continue
    Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(result, key)!)
  }
  return copy
}
function resultSummary(value: unknown): string | null {
  const row = parseObject(value)
  return row && typeof row.summary === "string" ? safeText(row.summary, 500) : value === null ? null : "Result stored; details are available through the scoped wait observation."
}
function safeText(value: string | null, limit: number): string | null {
  if (value === null) return null
  const safe = redactSensitiveText(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  let output = ""
  for (const character of safe) {
    if (Buffer.byteLength(output + character, "utf8") > limit) break
    output += character
  }
  return output || null
}
function parseObject(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}
