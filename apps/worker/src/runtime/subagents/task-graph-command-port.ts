import type { PoolClient } from "pg"
import type { TaskGraphProposal, TaskGraphReadiness } from "../planning/task-graph.js"
import type { SubagentTaskStatus } from "./types.js"

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
  readCurrent(scope: TaskGraphReadScope): Promise<TaskGraphCurrentState>
  /** Reads current graph state using a caller-owned transaction and client. */
  readCurrentWithClient?(client: PoolClient, scope: TaskGraphReadScope): Promise<TaskGraphCurrentState>
}>
