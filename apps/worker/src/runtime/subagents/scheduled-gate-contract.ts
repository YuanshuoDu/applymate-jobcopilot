import { createHash } from "node:crypto"
import { scheduledAnalyzeCheckpointEvidence } from "../turns/turn-question-contract.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type {
  TaskGraphExecutionScope,
  TaskGraphReadScope,
} from "./task-graph-command-port.js"
import type { ScheduledAutomationPipelineAttestation } from "./scheduled-automation-pipeline-bridge.js"
import type { TaskGraphProposal } from "../planning/task-graph.js"

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

export type ScheduledGateQuestionKind = "borderline_match" | "weak_cover_letter"
export type ScheduledGateChoiceId = "add_to_pending" | "skip" | "lower_threshold" | "continue" | "review"
export type ScheduledGateQuestion = Readonly<{
  status: "question_required"
  kind: ScheduledGateQuestionKind
  jobIds: readonly string[]
  candidateSetDigest: string
  allowedChoiceIds: readonly ScheduledGateChoiceId[]
}>
export type ScheduledGateCompletion = Readonly<{
  status: "completed"
  nextStage: "execute"
  approvedJobIds: readonly string[]
  pendingJobIds: readonly string[]
  skippedJobIds: readonly string[]
  counts: Readonly<{ approved: number; pending: number; skipped: number }>
}>
export type ScheduledGateResult = ScheduledGateQuestion | ScheduledGateCompletion
export type ScheduledGateTaskEnvelope = Readonly<{
  finalItemId: null
  finalText: ""
  status: "waiting_for_user" | "completed"
  stepCount: 0
  toolCallCount: 0
  taskGraphVerificationReport: null
  structuredResult: ScheduledGateResult
}>
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

const MAX_JOBS = 50
const CHOICES: Readonly<Record<ScheduledGateQuestionKind, readonly ScheduledGateChoiceId[]>> = Object.freeze({
  borderline_match: Object.freeze(["add_to_pending", "skip", "lower_threshold"] as const),
  weak_cover_letter: Object.freeze(["continue", "review", "skip"] as const),
})

/** Parses only the bounded public Gate DTO; private question bindings and material text are not part of this contract. */
export function parseScheduledGateResult(value: unknown, expectedJobIds: readonly string[]): ScheduledGateResult | null {
  if (!validIds(expectedJobIds)) return null
  const row = exactRecord(value)
  if (!row) return null
  if (row.status === "question_required") {
    const question = exactRecord(value, ["status", "kind", "jobIds", "candidateSetDigest", "allowedChoiceIds"])
    const kind = question?.kind
    const ids = question && idsOrNull(question.jobIds)
    if (!question || !isQuestionKind(kind) || !ids || ids.length === 0
      || (kind === "weak_cover_letter" && ids.length !== 1)
      || ids.some(id => !expectedJobIds.includes(id))
      || question.candidateSetDigest !== scheduledGateCandidateSetDigest(kind, ids)
      || !sameStrings(question.allowedChoiceIds, CHOICES[kind])) return null
    return {
      status: "question_required",
      kind,
      jobIds: ids,
      candidateSetDigest: question.candidateSetDigest as string,
      allowedChoiceIds: [...CHOICES[kind]],
    }
  }

  const completion = exactRecord(value, ["status", "nextStage", "approvedJobIds", "pendingJobIds", "skippedJobIds", "counts"])
  const approved = completion && idsOrNull(completion.approvedJobIds)
  const pending = completion && idsOrNull(completion.pendingJobIds)
  const skipped = completion && idsOrNull(completion.skippedJobIds)
  const counts = completion && exactRecord(completion.counts, ["approved", "pending", "skipped"])
  if (!completion || completion.status !== "completed" || completion.nextStage !== "execute"
    || !approved || !pending || !skipped || !counts
    || approved.length !== 0 || counts.approved !== 0
    || !sameSet([...approved, ...pending, ...skipped], expectedJobIds)
    || new Set([...approved, ...pending, ...skipped]).size !== expectedJobIds.length
    || counts.approved !== approved.length || counts.pending !== pending.length || counts.skipped !== skipped.length) return null
  return {
    status: "completed",
    nextStage: "execute",
    approvedJobIds: approved,
    pendingJobIds: pending,
    skippedJobIds: skipped,
    counts: { approved: approved.length, pending: pending.length, skipped: skipped.length },
  }
}

/** Correlates the fixed invocation envelope with its row status and strict inner DTO. */
export function parseScheduledGateTaskEnvelope(
  value: unknown,
  taskStatus: unknown,
  expectedJobIds: readonly string[],
): ScheduledGateTaskEnvelope | null {
  const row = exactRecord(parseJson(value), [
    "finalItemId", "finalText", "status", "stepCount", "toolCallCount", "taskGraphVerificationReport", "structuredResult",
  ])
  const structuredResult = row && parseScheduledGateResult(row.structuredResult, expectedJobIds)
  const status = structuredResult?.status === "question_required" ? "waiting_for_user"
    : structuredResult?.status === "completed" ? "completed" : null
  if (!row || !structuredResult || !status || row.status !== status || taskStatus !== status
    || row.finalItemId !== null || row.finalText !== "" || row.stepCount !== 0 || row.toolCallCount !== 0
    || row.taskGraphVerificationReport !== null) return null
  return {
    finalItemId: null, finalText: "", status, stepCount: 0, toolCallCount: 0,
    taskGraphVerificationReport: null, structuredResult,
  }
}

/** Validates a private fixed choice against the freshly recomputed public question. */
export function parseScheduledGateChoice(value: unknown, question: ScheduledGateQuestion): ScheduledGateChoiceId | null {
  const choice = exactRecord(value, ["kind", "jobIds", "choiceId"])
  const ids = choice && idsOrNull(choice.jobIds)
  if (!choice || choice.kind !== question.kind || !ids || !sameSet(ids, question.jobIds)
    || !CHOICES[question.kind].includes(choice.choiceId as ScheduledGateChoiceId)) return null
  return choice.choiceId as ScheduledGateChoiceId
}

/** Digest input matches the Web projection: [kind, sorted job IDs]. */
export function scheduledGateCandidateSetDigest(kind: ScheduledGateQuestionKind, jobIds: readonly string[]): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify([kind, [...jobIds].sort()]), "utf8").digest("hex")
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return null }
}
function isQuestionKind(value: unknown): value is ScheduledGateQuestionKind {
  return value === "borderline_match" || value === "weak_cover_letter"
}
function validIds(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length <= MAX_JOBS
    && dense(value) && value.every(validId) && new Set(value).size === value.length
}
function idsOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= MAX_JOBS && dense(value)
    && value.every(validId) && new Set(value).size === value.length ? [...value] : null
}
function dense(value: readonly unknown[]): boolean {
  return Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string"
      && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
function exactRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (keys && (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)))) return null
    for (const key of ownKeys) {
      if (typeof key !== "string") return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
    }
    return value as Record<string, unknown>
  } catch {
    return null
  }
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
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && dense(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && right.every(id => left.includes(id))
}
