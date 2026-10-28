import { scheduledAnalyzeCheckpointEvidence } from "../turns/turn-question-contract.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type {
  TaskGraphExecutionScope,
  TaskGraphReadScope,
} from "./task-graph-command-port.js"
import type { ScheduledAutomationPipelineAttestation } from "./scheduled-automation-pipeline-bridge.js"
import type { TaskGraphProposal } from "../planning/task-graph.js"
export { parseScheduledGateChoice, parseScheduledGateResult, parseScheduledGateTaskEnvelope, scheduledGateCandidateSetDigest } from "./scheduled-gate-result-contract.js"
export type { ScheduledGateChoiceId, ScheduledGateCompletion, ScheduledGateQuestion, ScheduledGateQuestionKind, ScheduledGateResult,
  ScheduledGateTaskEnvelope } from "./scheduled-gate-result-contract.js"

export const SCHEDULED_GATE_TEMPLATE_ID = "gate" as const
export const SCHEDULED_GATE_ROLE = "prepare" as const
export const SCHEDULED_GATE_TASK_TYPE = "scheduled_taskgraph_gate" as const
export const SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA = "agent-harness.v2.scheduled-taskgraph-gate-completion.v1" as const
export const SCHEDULED_GATE_NODE_GOAL = "Review the exact server-prepared applications and return the fixed pending or skip decisions required by the scheduled Gate policy." as const
export const SCHEDULED_GATE_NODE_CRITERIA = Object.freeze([
  "Return only the strict scheduled Gate result for the exact server-prepared job set; never mark a job approved.",
  "Ask only the fixed-choice question produced by the scheduled Gate policy when required.",
  "Never submit applications, contact employers, or expose private job material.",
])
export const SCHEDULED_GATE_OUTPUT_SCHEMA = Object.freeze({
  schemaVersion: ROLE_RESULT_SCHEMA,
  role: SCHEDULED_GATE_ROLE,
  taskType: SCHEDULED_GATE_TASK_TYPE,
})
const MAX_JOBS = 50

export type ScheduledGateCompletionProof = Readonly<{
  schemaVersion: typeof SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA
  graphRevision: number
  prepareProof: ScheduledPrepareTaskGraphProof
  gate: Readonly<{ taskId: string; attemptCount: number; resultDigest: string; completedEventRevision: number }>
}>
export type ScheduledAnalyzeCheckpointHandoff = Readonly<{
  status: "analyze_checkpointed"
  continuationKey: string
  checkpointDigest: string
  claimTokenDigest: string
  executionId: string
  executionAttemptCount: number
}>
export type ScheduledTaskGraphExecutionOwner = Readonly<{ executionId: string; executionAttemptCount: number }>
export type TaskGraphScheduledPrepareInput = Readonly<{
  scope: TaskGraphExecutionScope
  executionOwner: ScheduledTaskGraphExecutionOwner
  handoff: ScheduledAnalyzeCheckpointHandoff
  attestation: ScheduledAutomationPipelineAttestation
  proposal: TaskGraphProposal
}>
export type TaskGraphScheduledGateInput = Readonly<{
  scope: TaskGraphExecutionScope
  executionOwner: ScheduledTaskGraphExecutionOwner
  handoff: ScheduledAnalyzeCheckpointHandoff
  attestation: ScheduledAutomationPipelineAttestation
  prepareProof: ScheduledPrepareTaskGraphProof
  proposal: TaskGraphProposal
}>
export type TaskGraphScheduledGateResumeInput = Readonly<{
  scope: TaskGraphExecutionScope
  executionOwner: ScheduledTaskGraphExecutionOwner
  gateTaskId: string
  requestAttemptCount: number
  waitId: string
  now: Date
}>
export type TaskGraphScheduledGateResumeReceipt = Readonly<{
  status: "accepted" | "duplicate"
  taskId: string
  requestAttemptCount: number
  resumedAttemptCount: number
  revision: number
  readyTaskIds: readonly string[]
}>
export type TaskGraphScheduledGateCompletionInput = Readonly<{
  scope: TaskGraphReadScope
  executionOwner: ScheduledTaskGraphExecutionOwner
  prepareProof: ScheduledPrepareTaskGraphProof
}>
export type ScheduledGateCheckpointEvidence = NonNullable<ReturnType<typeof scheduledAnalyzeCheckpointEvidence>>
  & Readonly<{ prepareWaitContinuationKey: string }>

/** The private registration command constructs this fixed server-owned leaf, never caller-supplied node content. */
export function scheduledGateProposal(expectedRevision: number): TaskGraphProposal {
  return Object.freeze({ expectedRevision, nodes: Object.freeze([Object.freeze({ key: SCHEDULED_GATE_TEMPLATE_ID,
    templateId: SCHEDULED_GATE_TEMPLATE_ID, goal: SCHEDULED_GATE_NODE_GOAL, successCriteria: SCHEDULED_GATE_NODE_CRITERIA,
    dependsOn: Object.freeze(["prepare"]) })]) })
}

/** Reuses the Analyze checkpoint validator while accepting only its persisted Gate-stage projection. */
export function scheduledGateCheckpointEvidence(value: unknown): ScheduledGateCheckpointEvidence | null {
  const state = safeRecord(value)
  if (!state || state.nextStage !== "gate") return null
  const evidence = scheduledAnalyzeCheckpointEvidence({ ...state, nextStage: "prepare" })
  const continuation = safeRecord(state.scheduledTaskGraphContinuation)
  return evidence && typeof continuation?.key === "string"
    ? { ...evidence, prepareWaitContinuationKey: continuation.key } : null
}

/** Projects only jobs whose exact persisted Prepare result says material preparation succeeded. */
export function scheduledGatePreparedJobIds(prepareProof: ScheduledPrepareTaskGraphProof): string[] | null {
  return scheduledGatePreparedJobIdsFromResult(prepareProof.result)
}

/** Extracts the immutable prepared subset from an already-persisted Prepare result projection. */
export function scheduledGatePreparedJobIdsFromResult(value: unknown): string[] | null {
  try {
    const jobs = safeRecord(value)?.jobs
    if (!Array.isArray(jobs) || jobs.length > MAX_JOBS || Reflect.ownKeys(jobs).length !== jobs.length + 1
      || !Reflect.ownKeys(jobs).every(key => key === "length" || typeof key === "string"
        && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < jobs.length)) return null
    const seen = new Set<string>(), prepared: string[] = []
    for (const job of jobs) {
      if (!job || !validId(job.jobId) || !["prepared", "skipped", "failed"].includes(job.status) || seen.has(job.jobId)) return null
      seen.add(job.jobId)
      if (job.status === "prepared") prepared.push(job.jobId)
    }
    return prepared
  } catch { return null }
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
