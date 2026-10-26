import type { PoolClient } from "pg"
import type { TaskGraphProposal, TaskGraphReadiness, TaskGraphRepairOf } from "../planning/task-graph.js"
import type { TaskGraphExecutionScope, TaskGraphScheduleInput, TaskGraphScheduleNode, TaskGraphScheduleReceipt, TaskGraphScheduledPrepareReceipt } from "./task-graph-schedule-input.js"
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
import type { TaskGraphDiscoveryRecoveryPage, TaskGraphDiscoveryRecoveryPageRequest } from "./task-graph-discovery-recovery-page-contract.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import type { TaskGraphExecutionFailureCategory } from "./task-graph-failure-category.js"
import type { TaskGraphStructuredOutputFailureCategory } from "./task-graph-structured-failure-category.js"
import type { DiscoveryAttemptHealth } from "./child-discovery-attempt.js"
import type { TaskGraphHistoricalDiscoveryPage, TaskGraphHistoricalDiscoveryPageRequest } from "./task-graph-historical-discovery-page-contract.js"
import type { TaskGraphSourceCheckpoint, TaskGraphSourceIntentNode } from "./task-graph-pg-source-provenance.js"
import type { TaskGraphScheduledAuditInput, TaskGraphScheduledAuditCompletionInput, TaskGraphScheduledAuditInvocationInput, TaskGraphScheduledAuditResumeInput, ScheduledAuditAppendReceipt, ScheduledAuditCompletionProof, ScheduledAuditInvocationProof, ScheduledAuditResumeContext } from "./scheduled-audit-contract.js"
export type { TaskGraphExecutionScope, TaskGraphScheduleInput, TaskGraphScheduleNode, TaskGraphScheduleReceipt, TaskGraphScheduledPrepareReceipt, TaskGraphTaskTemplate } from "./task-graph-schedule-input.js"
import type {
  ScheduledAnalyzeCheckpointHandoff,
  ScheduledGateCompletionProof,
  ScheduledTaskGraphExecutionOwner,
  TaskGraphScheduledGateCompletionInput,
  TaskGraphScheduledGateInput,
  TaskGraphScheduledGateResumeInput,
  TaskGraphScheduledGateResumeReceipt,
  TaskGraphScheduledPrepareInput,
} from "./scheduled-gate-contract.js"
export type {
  ScheduledAnalyzeCheckpointHandoff,
  ScheduledTaskGraphExecutionOwner,
  TaskGraphScheduledGateCompletionInput,
  TaskGraphScheduledGateInput,
  TaskGraphScheduledGateResumeInput,
  TaskGraphScheduledGateResumeReceipt,
  TaskGraphScheduledPrepareInput,
} from "./scheduled-gate-contract.js"
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
  TaskGraphPrepareProjectionJob,
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

/** Exact proposal shape accepted by the scheduled-only Prepare command. */
export function parseScheduledPrepareProposal(value: unknown, analystKey: string, analyzeRevision: number): TaskGraphProposal | undefined {
  if (!boundedString(analystKey, 128) || !Number.isSafeInteger(analyzeRevision) || analyzeRevision < 1
    || !exactRecord(value, "expectedRevision,nodes") || value.expectedRevision !== analyzeRevision
    || !denseArray(value.nodes, 1) || value.nodes.length !== 1) return undefined
  const node = value.nodes[0]
  if (!exactRecord(node, "dependsOn,goal,key,successCriteria,templateId") || node.key !== "prepare" || node.templateId !== "prepare"
    || !boundedString(node.goal, 1200) || !denseArray(node.successCriteria, 8) || node.successCriteria.length === 0
    || node.successCriteria.some(item => !boundedString(item, 320)) || !denseArray(node.dependsOn, 1)
    || node.dependsOn.length !== 1 || node.dependsOn[0] !== analystKey) return undefined
  return value as TaskGraphProposal
}

export type RegisteredScoutEnvelope = Readonly<{
  role: "scout"
  taskType: string
  expectedOutputSchema: Readonly<{ schemaVersion: typeof ROLE_RESULT_SCHEMA; role: "scout" }>
  allowedActions: readonly string[]
}>

export function parseRegisteredScoutEnvelope(value: unknown): RegisteredScoutEnvelope | undefined {
  if (!exactRecord(value, "allowedActions,expectedOutputSchema,role,taskType") || value.role !== "scout"
    || !boundedString(value.taskType, 128) || !exactRecord(value.expectedOutputSchema, "role,schemaVersion")
    || value.expectedOutputSchema.schemaVersion !== ROLE_RESULT_SCHEMA || value.expectedOutputSchema.role !== "scout"
    || !scoutActions(value.allowedActions)) return undefined
  return { role: "scout", taskType: value.taskType,
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: [...value.allowedActions] }
}

export function taskGraphNodeKeysMatch(value: Record<string, unknown>, keys: string): boolean {
  const actual = Reflect.ownKeys(value)
  if (!actual.every((key): key is string => typeof key === "string")) return false
  const sorted = actual.sort().join(",")
  return sorted === keys || Object.hasOwn(value, "registeredScoutEnvelope")
    && actual.filter(key => key !== "registeredScoutEnvelope").join(",") === keys
}

function scoutActions(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1
    || !Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string"
      && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)) return false
  return Array.from({ length: value.length }, (_, index) => {
    const action = value[index]
    return typeof action === "string" && action.trim().length > 0 && action.length <= 128
  }).every(Boolean)
}

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
  discoveryAttemptHealth?: DiscoveryAttemptHealth
  verificationCriterionIds?: readonly string[]
  verification?: TaskGraphVerificationContract
  verificationReport?: TaskGraphVerificationReport
  repairOf?: TaskGraphRepairOf
  repairReceipt?: TaskGraphRepairReceipt
  native?: TaskGraphNativeNodeView
  nativeResult?: TaskGraphNativeResultReceipt
  executionFailureCategory?: TaskGraphExecutionFailureCategory
  structuredOutputFailureCategory?: TaskGraphStructuredOutputFailureCategory
  failureReason: string | null
}>
export type TaskGraphCurrentState = Readonly<{
  revision: number
  nodes: readonly TaskGraphCurrentNode[]
  rootSuccessCriteria?: readonly string[]
  planningFacts?: import("./task-graph-planning-facts.js").TaskGraphPlanningFacts
}>
/** Private planning read; checkpoint data stays outside the model-facing state. */
export type TaskGraphPlanningCurrentState = Readonly<{
  current: TaskGraphCurrentState & Readonly<{ sourceIntent: readonly TaskGraphSourceIntentNode[] }>
  currentInputCheckpoint: TaskGraphSourceCheckpoint | null
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
  /** Scheduled-only same-root append; production callers must fail closed if absent. */
  appendScheduledPrepare?(input: TaskGraphScheduledPrepareInput): Promise<TaskGraphScheduledPrepareReceipt>
  /** Server-only fixed Gate registration; never exposed to model planning. */
  appendScheduledGate?(input: TaskGraphScheduledGateInput): Promise<TaskGraphScheduleReceipt>
  /** Atomic private-answer acknowledgement, Gate requeue, lifecycle, and outbox write. */
  resumeScheduledGateChoice?(input: TaskGraphScheduledGateResumeInput): Promise<TaskGraphScheduledGateResumeReceipt>
  /** Re-loads strict Gate result/history and returns proof only after canonical completion validation. */
  verifyScheduledGateCompletion?(input: TaskGraphScheduledGateCompletionInput): Promise<ScheduledGateCompletionProof | null>
  /** Server-only fixed Audit registration and owner-fenced completion proof. */
  appendScheduledAudit?(input: TaskGraphScheduledAuditInput): Promise<ScheduledAuditAppendReceipt>
  verifyScheduledAuditCompletion?(input: TaskGraphScheduledAuditCompletionInput): Promise<ScheduledAuditCompletionProof | null>
  readScheduledAuditInvocationProof?(input: TaskGraphScheduledAuditInvocationInput): Promise<ScheduledAuditInvocationProof | null>
  readScheduledAuditResumeContext?(input: TaskGraphScheduledAuditResumeInput): Promise<ScheduledAuditResumeContext>
  appendAndScheduleWithReconciliation?(input: TaskGraphScheduleInput, operation: import("./steering-reconciliation-contract.js").SteeringReconciliationOperation): Promise<TaskGraphScheduleReceipt>
  reconcileSteering?(operation: import("./steering-reconciliation-contract.js").SteeringReconciliationOperation): Promise<TaskGraphKeepReconciliationReceipt>
  /** Native root coordination is optional for legacy ports; production callers must fail closed if absent. */
  appendNativeCoordination?(input: TaskGraphNativeCommandInput): Promise<TaskGraphNativeCommandReceipt>
  readCurrent(scope: TaskGraphReadScope): Promise<TaskGraphCurrentState>
  /** Reads current graph state using a caller-owned transaction and client. */
  readCurrentWithClient?(client: PoolClient, scope: TaskGraphReadScope): Promise<TaskGraphCurrentState>
  /** Root-only planning read with receipt-derived source intent and a private checkpoint for dependency promotion. */
  readCurrentForPlanning?(scope: TaskGraphReadScope): Promise<TaskGraphPlanningCurrentState>
  /** Reads planning provenance using a caller-owned transaction; checkpoint remains private to the context builder. */
  readCurrentForPlanningWithClient?(client: PoolClient, scope: TaskGraphReadScope): Promise<TaskGraphPlanningCurrentState>
  /** Reads one bounded advisory page from the current owner-fenced graph. */
  readCurrentResultPage?(scope: TaskGraphReadScope, request: TaskGraphResultPageRequest): Promise<TaskGraphResultPage>
  /** Reads unverified Scout IDs only from a reselected same-session prior Root. */
  readHistoricalDiscoveryPage?(scope: TaskGraphExecutionScope, request: TaskGraphHistoricalDiscoveryPageRequest): Promise<TaskGraphHistoricalDiscoveryPage>
  /** Reads bounded unverified canonical IDs from a failed ordinary Scout under the same owner fence. */
  readCurrentDiscoveryRecoveryPage?(scope: TaskGraphReadScope, request: TaskGraphDiscoveryRecoveryPageRequest): Promise<TaskGraphDiscoveryRecoveryPage>
}>
