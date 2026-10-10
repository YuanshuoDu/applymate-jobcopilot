import type { PoolClient } from "pg"
import type { TaskGraphProposal, TaskGraphReadiness, TaskGraphRepairOf } from "../planning/task-graph.js"
import type { SubagentTaskStatus } from "./types.js"
import {
  TASK_GRAPH_VERIFIER_VERSION,
  parseStoredTaskGraphVerificationReport,
  publicTaskGraphVerificationReport,
  type TaskGraphVerificationReport,
} from "./task-graph-verification-report.js"
import type { TaskGraphNativeCommandReceipt, TaskGraphNativeNodeView, TaskGraphNativeResultReceipt } from "./task-graph-native-command.js"
import type { TaskGraphNativeCommandInput } from "./task-graph-native-request.js"
import type { TaskGraphResultProjection } from "./task-graph-result-projection-contract.js"
import type { TaskGraphResultPage, TaskGraphResultPageRequest } from "./task-graph-result-page-contract.js"
export type {
  TaskGraphNativeChildReceipt,
  TaskGraphNativeCommandReceipt,
  TaskGraphNativeNodeView,
  TaskGraphNativeResultReceipt,
  TaskGraphNativeSourceProvenance,
  TaskGraphNativeSpawnRequest,
} from "./task-graph-native-command.js"
export type { TaskGraphNativeCommandInput, TaskGraphNativeFollowupRequest, TaskGraphNativeRequest, TaskGraphNativeReplacementRequest } from "./task-graph-native-request.js"
export { TASK_GRAPH_VERIFIER_VERSION, parseStoredTaskGraphVerificationReport, publicTaskGraphVerificationReport } from "./task-graph-verification-report.js"
export type { TaskGraphVerificationReport } from "./task-graph-verification-report.js"
export { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-result-projection-contract.js"
export type {
  TaskGraphProjectionSource,
  TaskGraphProjectionEvidenceKind,
  TaskGraphScoutProjectionItem,
  TaskGraphAnalystProjectionItem,
  TaskGraphArtifactProjectionReference,
  TaskGraphResultProjection,
} from "./task-graph-result-projection-contract.js"
export const TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION = "agent-harness.v2.task-graph-repair-receipt.v1" as const
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
export type TaskGraphRepairReceipt = Readonly<{
  schemaVersion: typeof TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION; graphRootTaskId: string; targetNodeKey: string; targetTaskId: string; criterionIds: string[]
  repairNodeKey: string; repairTaskId: string; verifierVersion: typeof TASK_GRAPH_VERIFIER_VERSION; evidenceDigest: string
}>

export function parseTaskGraphVerificationCriterionIds(value: unknown): string[] | undefined {
  if (!denseArray(value, 8) || value.some(id => typeof id !== "string" || !CRITERION_ID.test(id)) || new Set(value).size !== value.length) return undefined
  return [...value] as string[]
}

export function parseTaskGraphVerificationReport(value: unknown, criterionIds: readonly string[]): TaskGraphVerificationReport | undefined {
  const stored = parseStoredTaskGraphVerificationReport(value, criterionIds)
  return stored ? publicTaskGraphVerificationReport(stored) : undefined
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
  planningFacts?: import("./task-graph-planning-facts.js").TaskGraphPlanningFacts
}>
export class TaskGraphCommandError extends Error {
  constructor(readonly code: string, message: string, readonly currentRevision?: number) {
    super(message)
    this.name = "TaskGraphCommandError"
  }
}
export type TaskGraphKeepReconciliationReceipt = Readonly<{ decision: "keep"; revision: number; reconciledInputCount: number }>
export type TaskGraphCommandPort = Readonly<{
  appendAndSchedule(input: TaskGraphScheduleInput): Promise<TaskGraphScheduleReceipt>
  appendAndScheduleWithReconciliation?(input: TaskGraphScheduleInput, operation: import("./steering-reconciliation-contract.js").SteeringReconciliationOperation): Promise<TaskGraphScheduleReceipt>
  reconcileSteering?(operation: import("./steering-reconciliation-contract.js").SteeringReconciliationOperation): Promise<TaskGraphKeepReconciliationReceipt>
  /** Native root coordination is optional for legacy ports; production callers must fail closed if absent. */
  appendNativeCoordination?(input: TaskGraphNativeCommandInput): Promise<TaskGraphNativeCommandReceipt>
  readCurrent(scope: TaskGraphReadScope): Promise<TaskGraphCurrentState>
  /** Reads current graph state using a caller-owned transaction and client. */
  readCurrentWithClient?(client: PoolClient, scope: TaskGraphReadScope): Promise<TaskGraphCurrentState>
  /** Reads one bounded advisory page from the current owner-fenced graph. */
  readCurrentResultPage?(scope: TaskGraphReadScope, request: TaskGraphResultPageRequest): Promise<TaskGraphResultPage>
}>
