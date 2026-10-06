import type { PoolClient } from "pg"
import type { TaskGraphProposal, TaskGraphReadiness, TaskGraphRepairOf } from "../planning/task-graph.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import type { SubagentTaskStatus } from "./types.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-pg-verification.js"
import type { TaskGraphNativeCommandInput, TaskGraphNativeCommandReceipt, TaskGraphNativeNodeView, TaskGraphNativeResultReceipt } from "./task-graph-native-command.js"
export type {
  TaskGraphNativeChildReceipt,
  TaskGraphNativeCommandInput,
  TaskGraphNativeCommandReceipt,
  TaskGraphNativeFollowupRequest,
  TaskGraphNativeNodeView,
  TaskGraphNativeRequest,
  TaskGraphNativeResultReceipt,
  TaskGraphNativeSourceProvenance,
  TaskGraphNativeSpawnRequest,
} from "./task-graph-native-command.js"

export const TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION = "agent-harness.v2.task-graph-repair-receipt.v1" as const
const VERIFICATION_REASONS = new Set<TaskGraphVerificationReasonCode>([
  "criteria_met", "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid",
  "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous",
  "result_invalid", "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved",
])
const CRITERION_ID = /^[a-z][a-z0-9._-]{0,63}$/
function boundedString(value: unknown, limit: number): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= limit }
function exactRecord(value: unknown, keys: string): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return false
  return Object.keys(value).sort().join(",") === keys
}
function denseArray(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false
  return Reflect.ownKeys(value).every(key => key === "length" || (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length))
}

export type TaskGraphVerificationReport = Readonly<{
  verifierVersion: typeof TASK_GRAPH_VERIFIER_VERSION; status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode
  criteria: Array<{ criterionId: string; status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode }>
  evidenceDigest: string | null; resultDigest: string | null
}>
export type TaskGraphRepairReceipt = Readonly<{
  schemaVersion: typeof TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION; graphRootTaskId: string; targetNodeKey: string; targetTaskId: string; criterionIds: string[]
  repairNodeKey: string; repairTaskId: string; verifierVersion: typeof TASK_GRAPH_VERIFIER_VERSION; evidenceDigest: string
}>

export function parseTaskGraphVerificationCriterionIds(value: unknown): string[] | undefined {
  if (!denseArray(value, 8) || value.some(id => typeof id !== "string" || !CRITERION_ID.test(id)) || new Set(value).size !== value.length) return undefined
  return [...value] as string[]
}

export function parseTaskGraphVerificationReport(value: unknown, criterionIds: readonly string[]): TaskGraphVerificationReport | undefined {
  if (!exactRecord(value, "criteria,evidenceDigest,reasonCode,resultDigest,status,verifierVersion") || value.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION
    || !["passed", "failed", "unverified"].includes(String(value.status)) || !VERIFICATION_REASONS.has(value.reasonCode as TaskGraphVerificationReasonCode)
    || !denseArray(value.criteria, 8) || value.criteria.length !== criterionIds.length
    || !(value.status === "unverified" && (value.evidenceDigest === null || typeof value.evidenceDigest === "string" && /^[a-f0-9]{64}$/.test(value.evidenceDigest))
      || (value.status !== "unverified" && typeof value.evidenceDigest === "string" && /^[a-f0-9]{64}$/.test(value.evidenceDigest)))
    || !(value.resultDigest === null || typeof value.resultDigest === "string" && /^[a-f0-9]{64}$/.test(value.resultDigest))) return undefined
  const criteria: NonNullable<TaskGraphVerificationReport["criteria"]>[number][] = []
  for (let index = 0; index < value.criteria.length; index += 1) {
    const item = value.criteria[index]
    if (!exactRecord(item, "criterionId,reasonCode,status") || item.criterionId !== criterionIds[index]
      || !["passed", "failed", "unverified"].includes(String(item.status)) || !VERIFICATION_REASONS.has(item.reasonCode as TaskGraphVerificationReasonCode)) return undefined
    if (item.status === "passed" && item.reasonCode !== "criteria_met"
      || item.status === "failed" && item.reasonCode !== "criterion_not_met" && item.reasonCode !== "reported_score_below_minimum"
      || item.status === "unverified" && ["criteria_met", "criterion_not_met", "reported_score_below_minimum", "repair_target_unresolved"].includes(String(item.reasonCode))) return undefined
    criteria.push({ criterionId: item.criterionId as string, status: item.status as "passed" | "failed" | "unverified", reasonCode: item.reasonCode as TaskGraphVerificationReasonCode })
  }
  const status = value.status as TaskGraphVerificationReport["status"], reasonCode = value.reasonCode as TaskGraphVerificationReasonCode
  const repairUnresolved = status === "unverified" && reasonCode === "repair_target_unresolved" && value.evidenceDigest === null
    && typeof value.resultDigest === "string" && /^[a-f0-9]{64}$/.test(value.resultDigest)
    && criteria.every(item => item.status === "passed" && item.reasonCode === "criteria_met")
  const coherent = repairUnresolved || (status === "passed" ? reasonCode === "criteria_met" && typeof value.resultDigest === "string" && criteria.every(item => item.status === "passed")
    : status === "failed" ? typeof value.resultDigest === "string" && criteria.some(item => item.status === "failed") && reasonCode === criteria.find(item => item.status === "failed")?.reasonCode && criteria.every(item => item.status !== "unverified")
      : criteria.every(item => item.status === "unverified" && item.reasonCode === reasonCode) && (value.evidenceDigest === null ? value.resultDigest === null : typeof value.resultDigest === "string"))
  if (!coherent) return undefined
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status, reasonCode, criteria, evidenceDigest: value.evidenceDigest as string | null, resultDigest: value.resultDigest as string | null }
}

export function parseTaskGraphRepairOf(value: unknown): TaskGraphRepairOf | undefined {
  if (!exactRecord(value, "criterionIds,graphRootTaskId,nodeKey,taskId") || !boundedString(value.graphRootTaskId, 128)
    || !boundedString(value.nodeKey, 128) || !boundedString(value.taskId, 128)) return undefined
  const criterionIds = parseTaskGraphVerificationCriterionIds(value.criterionIds)
  return criterionIds ? { graphRootTaskId: value.graphRootTaskId, nodeKey: value.nodeKey, taskId: value.taskId, criterionIds } : undefined
}

export function taskGraphVerificationReportMatchesStatus(report: TaskGraphVerificationReport, status: string): boolean {
  return status === "completed" ? report.status === "passed"
    : status === "failed" ? report.status === "failed" || report.status === "unverified" : false
}

export function parseTaskGraphRepairReceipt(value: unknown, expected: Readonly<{
  repairOf?: TaskGraphRepairOf; repairNodeKey: string; repairTaskId: string; report?: TaskGraphVerificationReport
}>): TaskGraphRepairReceipt | undefined {
  const relation = expected.repairOf, report = expected.report
  if (!relation || report?.status !== "passed" || !report.evidenceDigest || !exactRecord(value, "criterionIds,evidenceDigest,graphRootTaskId,repairNodeKey,repairTaskId,schemaVersion,targetNodeKey,targetTaskId,verifierVersion")
    || value.schemaVersion !== TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION || value.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION || value.graphRootTaskId !== relation.graphRootTaskId
    || value.targetNodeKey !== relation.nodeKey || value.targetTaskId !== relation.taskId
    || value.repairNodeKey !== expected.repairNodeKey || value.repairTaskId !== expected.repairTaskId
    || value.evidenceDigest !== report.evidenceDigest || !boundedString(value.graphRootTaskId, 128)
    || !boundedString(value.targetNodeKey, 128) || !boundedString(value.targetTaskId, 128)
    || !boundedString(value.repairNodeKey, 128) || !boundedString(value.repairTaskId, 128)) return undefined
  const criterionIds = parseTaskGraphVerificationCriterionIds(value.criterionIds)
  return criterionIds?.join("\0") === relation.criterionIds.join("\0")
    ? { schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: relation.graphRootTaskId, targetNodeKey: relation.nodeKey, targetTaskId: relation.taskId, criterionIds, repairNodeKey: expected.repairNodeKey, repairTaskId: expected.repairTaskId, verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: report.evidenceDigest }
    : undefined
}

/** Lease and lineage supplied by the currently executing parent task. */
export type TaskGraphExecutionScope = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  parentTaskId: string
  stepId: string
  turnLeaseOwner: string
  turnLeaseVersion: number
  parentLeaseOwner: string
  parentAttemptCount: number
}>

/** Server-owned template data; model input may choose only the registered ID. */
export type TaskGraphTaskTemplate = Readonly<{
  role: string
  taskType: string
  allowedActions: readonly string[]
  constraints?: readonly string[]
  context?: unknown
  expectedOutputSchema?: unknown
  maxAttempts?: number
}>

export type TaskGraphScheduleNode = Readonly<{
  key: string
  taskId: string
  status: Extract<SubagentTaskStatus, "queued" | "waiting">
}>

export type TaskGraphScheduleReceipt = Readonly<{
  status: "accepted" | "duplicate"
  revision: number
  nodes: readonly TaskGraphScheduleNode[]
  readyTaskIds: readonly string[]
}>

export type TaskGraphScheduleInput = Readonly<{
  scope: TaskGraphExecutionScope
  proposal: TaskGraphProposal
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
}>

/** Ownership fence for reads; it is never populated from model-controlled input. */
export type TaskGraphReadScope = Omit<TaskGraphExecutionScope, "stepId">

export type TaskGraphProjectionSource = "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio" | "other"
export type TaskGraphProjectionEvidenceKind = "job" | "persona" | "resume" | "source"
export const TASK_GRAPH_RESULT_PROJECTION_SCHEMA = "agent-harness.v2.task-graph.result-projection" as const
export type TaskGraphScoutProjectionItem = Readonly<{
  jobId: string
  source: TaskGraphProjectionSource
  evidenceKinds: readonly TaskGraphProjectionEvidenceKind[]
}>
export type TaskGraphAnalystProjectionItem = Readonly<{
  jobId: string
  score: number
  evidenceKinds: readonly TaskGraphProjectionEvidenceKind[]
}>
export type TaskGraphArtifactProjectionReference = Readonly<{
  artifactId: string
  version: number
  contentHash: string
  sourceDigest: string
}>
export type TaskGraphResultProjection =
  | Readonly<{ schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA; trust: "untrusted"; availability: "unavailable" }>
  | Readonly<{
    schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    trust: "untrusted"
    availability: "available"
    role: "scout"
    status: "completed" | "partial"
    candidateCount: number
    evidenceCount: number
    candidates: readonly TaskGraphScoutProjectionItem[]
  }>
  | Readonly<{
    schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    trust: "untrusted"
    availability: "available"
    role: "analyst"
    status: "completed" | "partial"
    findingCount: number
    evidenceCount: number
    findings: readonly TaskGraphAnalystProjectionItem[]
  }>
  | Readonly<{
    schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    trust: "untrusted"
    availability: "available"
    role: "writer"
    status: "completed"
    artifactRef: TaskGraphArtifactProjectionReference
  }>
  | Readonly<{
    schemaVersion: typeof TASK_GRAPH_RESULT_PROJECTION_SCHEMA
    trust: "untrusted"
    availability: "available"
    role: "reviewer"
    status: "completed"
    artifactRef: TaskGraphArtifactProjectionReference
    reviewStatus: "passed" | "needs_revision" | "rejected" | "stale"
    reviewHash: string
  }>
export type TaskGraphCurrentNode = Readonly<{
  key: string
  templateId: string
  goal: string
  successCriteria: readonly string[]
  dependsOn: readonly string[]
  taskId: string
  status: SubagentTaskStatus
  readiness: TaskGraphReadiness
  resultSummary: string | null
  resultProjection?: TaskGraphResultProjection
  verificationCriterionIds?: readonly string[]
  verificationReport?: TaskGraphVerificationReport
  repairOf?: TaskGraphRepairOf
  repairReceipt?: TaskGraphRepairReceipt
  native?: TaskGraphNativeNodeView
  nativeResult?: TaskGraphNativeResultReceipt
  failureReason: string | null
}>
export type TaskGraphCurrentState = Readonly<{
  revision: number
  nodes: readonly TaskGraphCurrentNode[]
}>
export class TaskGraphCommandError extends Error {
  constructor(readonly code: string, message: string, readonly currentRevision?: number) {
    super(message)
    this.name = "TaskGraphCommandError"
  }
}
export type TaskGraphCommandPort = Readonly<{
  appendAndSchedule(input: TaskGraphScheduleInput): Promise<TaskGraphScheduleReceipt>
  /** Native root coordination is optional for legacy ports; production callers must fail closed if absent. */
  appendNativeCoordination?(input: TaskGraphNativeCommandInput): Promise<TaskGraphNativeCommandReceipt>
  readCurrent(scope: TaskGraphReadScope): Promise<TaskGraphCurrentState>
  /** Reads current graph state using a caller-owned transaction and client. */
  readCurrentWithClient?(client: PoolClient, scope: TaskGraphReadScope): Promise<TaskGraphCurrentState>
}>
