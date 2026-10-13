import { createHash } from "node:crypto"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION, taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import type { GraphTaskRow, LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { parseTaskGraphRepairReceipt, parseTaskGraphVerificationReport } from "../subagents/task-graph-command-port.js"
import type { StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import { validateRoleResult } from "../subagents/role-results.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT } from "./turn-execution-types.js"

export type GateCriterion = Readonly<{ criterionId: string; status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode }>
export type GateReport = Readonly<{
  status: "passed" | "failed" | "unverified"
  reasonCode: TaskGraphVerificationReasonCode
  criteria: readonly GateCriterion[]
  unresolved: ReadonlySet<string>
  digest: string | null
  resultDigest: string | null
}>

export const TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA = "agent-harness.v2.task-graph-denial-checkpoint.v1" as const
export type TaskGraphDenialCheckpoint = Readonly<{
  schemaVersion: typeof TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA
  taskId: string
  graphRevision: number
  verificationDigest: string
}>

type Row = Record<string, unknown>
function row(value: unknown): Row {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return {} } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  try { const proto = Object.getPrototypeOf(parsed); return proto === Object.prototype || proto === null ? parsed as Row : {} } catch { return {} }
}
function exactKeys(value: Row, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function safeText(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

export function parseTaskGraphDenialCheckpoint(value: unknown, expectedTaskId?: string): TaskGraphDenialCheckpoint | null {
  const checkpoint = row(value)
  if (!exactKeys(checkpoint, "graphRevision,schemaVersion,taskId,verificationDigest")
    || checkpoint.schemaVersion !== TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA || !safeText(checkpoint.taskId)
    || expectedTaskId !== undefined && checkpoint.taskId !== expectedTaskId
    || !Number.isSafeInteger(checkpoint.graphRevision) || Number(checkpoint.graphRevision) < 1
    || typeof checkpoint.verificationDigest !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.verificationDigest)) return null
  return { schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, taskId: checkpoint.taskId,
    graphRevision: Number(checkpoint.graphRevision), verificationDigest: checkpoint.verificationDigest }
}

export function taskGraphDenialCheckpointFromDecision(value: unknown, expectedTaskId: string): TaskGraphDenialCheckpoint | null {
  const decision = row(value)
  if (!decision || decision.ok !== false || decision.blocker !== "task_graph_verification_unverified") return null
  try { return parseTaskGraphDenialCheckpoint(Reflect.get(value as object, TASK_GRAPH_DENIAL_CHECKPOINT), expectedTaskId) } catch { return null }
}

export function gateReport(node: StoredTaskGraphNode, result: unknown, role: string): GateReport | null {
  const stored = row(result), expected = node.verification?.criteria.map(item => item.id) ?? []
  if (node.verificationDisposition !== "typed" || !node.verification || role !== node.verification.role) return null
  const report = parseTaskGraphVerificationReport(stored.taskGraphVerificationReport, expected)
  let resultDigest: string | null = null
  try { if (Object.hasOwn(stored, "structuredResult")) resultDigest = taskGraphResultDigest(validateRoleResult(stored.structuredResult, role)) } catch { return null }
  if (!report || report.resultDigest !== resultDigest) return null
  if (report.reasonCode === "repair_target_unresolved") {
    if (!node.repairOf || report.status !== "unverified" || report.evidenceDigest !== null || !report.criteria.every(item => item.status === "passed")) return null
    return { status: "unverified", reasonCode: report.reasonCode, criteria: report.criteria,
      unresolved: new Set(node.repairOf.criterionIds), digest: null, resultDigest: report.resultDigest }
  }
  return { status: report.status, reasonCode: report.reasonCode, criteria: report.criteria,
    unresolved: new Set(report.criteria.filter(item => item.status !== "passed").map(item => item.criterionId)),
    digest: report.evidenceDigest, resultDigest: report.resultDigest }
}

export function repairIds(node: StoredTaskGraphNode, result: unknown, target: StoredTaskGraphNode, report: GateReport): string[] | null {
  const relation = node.repairOf, stored = row(result), receipt = row(stored.taskGraphRepairReceipt), ids = relation?.criterionIds
  if (!relation || !ids?.length || !report.digest || receipt.schemaVersion !== "agent-harness.v2.task-graph-repair-receipt.v1"
    || !exactKeys(receipt, "criterionIds,evidenceDigest,graphRootTaskId,repairNodeKey,repairTaskId,schemaVersion,targetNodeKey,targetTaskId,verifierVersion")
    || receipt.graphRootTaskId !== relation.graphRootTaskId || receipt.targetNodeKey !== target.key || receipt.targetTaskId !== target.taskId
    || receipt.repairNodeKey !== node.key || receipt.repairTaskId !== node.taskId || receipt.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION
    || receipt.evidenceDigest !== report.digest || !Array.isArray(receipt.criterionIds) || JSON.stringify(receipt.criterionIds) !== JSON.stringify(ids)) return null
  return [...ids]
}

function gateTaskStateMatches(task: GraphTaskRow, report: GateReport): boolean {
  if (report.status === "passed") return task.status === "completed" && task.failureReason === null
  const failureReason = report.reasonCode === "repair_target_unresolved"
    ? "task_graph_repair_target_unresolved" : `task_graph_verification_${report.status}`
  return task.status === "failed" && task.failureReason === failureReason
}

/** Hashes only the current parsed graph/check/report/repair state; goal and candidate prose never enter the digest. */
export function taskGraphTerminalVerificationDigest(loaded: LoadedGraph, rootTaskId: string): string | null {
  try {
    const revision = loaded.item?.revision
    if (loaded.rootTaskId !== rootTaskId || !loaded.snapshot || !Number.isSafeInteger(revision) || Number(revision) < 1
      || loaded.snapshot.nodes.length === 0 || loaded.snapshot.nodes.some(node => node.verificationDisposition !== "typed" || !node.verification)) return null
    const normalized = loaded.snapshot.nodes.map(node => {
      const task = loaded.tasks.get(node.taskId), role = node.verification!.role
      if (!task || task.id !== node.taskId || task.role !== role || !safeText(task.status, 32) || !(task.failureReason === null || safeText(task.failureReason, 256))) throw new Error("task_graph_denial_state_invalid")
      const report = gateReport(node, task.result, task.role)
      if (!report || !gateTaskStateMatches(task, report)) throw new Error("task_graph_denial_report_invalid")
      const result = row(task.result), hasReceipt = Object.hasOwn(result, "taskGraphRepairReceipt")
      let receipt: Readonly<{ present: false } | { present: true; criterionIds: readonly string[]; evidenceDigest: string }> = { present: false }
      if (node.repairOf) {
        if (node.repairOf.graphRootTaskId !== rootTaskId) throw new Error("task_graph_denial_repair_root_invalid")
        const target = loaded.snapshot!.nodes.find(candidate => candidate.key === node.repairOf!.nodeKey)
        if (!target || target.taskId !== node.repairOf.taskId || target.key === node.key) throw new Error("task_graph_denial_repair_target_invalid")
        if (report.status === "passed") {
          const criteria = repairIds(node, task.result, target, report)
          if (!criteria || !report.digest) throw new Error("task_graph_denial_receipt_invalid")
          receipt = { present: true, criterionIds: criteria, evidenceDigest: report.digest }
        } else if (hasReceipt) throw new Error("task_graph_denial_receipt_invalid")
      } else if (hasReceipt) throw new Error("task_graph_denial_receipt_invalid")
      const failureClass = task.failureReason === null ? "none"
        : task.failureReason === `task_graph_verification_${report.status}` ? "verification_status"
          : task.failureReason === "task_graph_repair_target_unresolved" ? "repair_target_unresolved" : "other"
      return {
        key: node.key, taskId: node.taskId, templateId: node.templateId, role,
        dependsOn: [...node.dependsOn], criteria: node.verification!.criteria.map(item => ({ id: item.id, check: item.check })),
        registeredScoutEnvelope: node.registeredScoutEnvelope ?? null,
        repairOf: node.repairOf ? { graphRootTaskId: node.repairOf.graphRootTaskId, nodeKey: node.repairOf.nodeKey,
          taskId: node.repairOf.taskId, criterionIds: [...node.repairOf.criterionIds] } : null,
        task: { status: task.status, failureClass },
        report: { status: report.status, reasonCode: report.reasonCode,
          criteria: report.criteria.map(item => ({ criterionId: item.criterionId, status: item.status, reasonCode: item.reasonCode })),
          evidenceDigest: report.digest, resultDigest: report.resultDigest },
        receipt,
      }
    })
    return createHash("sha256").update(JSON.stringify({ graphRevision: revision, nodes: normalized }), "utf8").digest("hex")
  } catch { return null }
}

export function buildTaskGraphDenialCheckpoint(loaded: LoadedGraph, rootTaskId: string): TaskGraphDenialCheckpoint | null {
  const verificationDigest = taskGraphTerminalVerificationDigest(loaded, rootTaskId)
  const graphRevision = loaded.item?.revision
  return verificationDigest && Number.isSafeInteger(graphRevision) && Number(graphRevision) >= 1
    ? { schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, taskId: rootTaskId, graphRevision: Number(graphRevision), verificationDigest }
    : null
}
