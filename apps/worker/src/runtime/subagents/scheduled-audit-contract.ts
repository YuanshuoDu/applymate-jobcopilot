import { createHash } from "node:crypto"
import { scheduledPipelineContinuationKeyVersion } from "@jobcopilot/agent-protocol"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { ScheduledAutomationPipelineAttestation } from "./scheduled-automation-pipeline-bridge.js"
import type { TaskGraphProposal } from "../planning/task-graph.js"
import type {
  ScheduledAnalyzeCheckpointHandoff,
  ScheduledGateCompletionProof,
  ScheduledTaskGraphExecutionOwner,
} from "./scheduled-gate-contract.js"
import type {
  TaskGraphExecutionScope,
  TaskGraphReadScope,
  TaskGraphScheduleReceipt,
} from "./task-graph-command-port.js"

export const SCHEDULED_AUDIT_TEMPLATE_ID = "scheduled_audit" as const
export const SCHEDULED_AUDIT_ROLE = "auditor" as const
export const SCHEDULED_AUDIT_TASK_TYPE = "scheduled_taskgraph_audit" as const
export const SCHEDULED_AUDIT_COMPLETION_PROOF_SCHEMA = "agent-harness.v2.scheduled-taskgraph-audit-completion.v1" as const
export const SCHEDULED_AUDIT_INVOCATION_PROOF_SCHEMA = "agent-harness.v2.scheduled-taskgraph-audit-invocation.v1" as const
export const SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA = "agent-harness.v2.scheduled-taskgraph-audit-binding.v1" as const
export const SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT = "agent.plan.scheduled_audit_binding" as const
export const SCHEDULED_AUDIT_OUTPUT_SCHEMA = Object.freeze({
  schemaVersion: ROLE_RESULT_SCHEMA,
  role: SCHEDULED_AUDIT_ROLE,
  taskType: SCHEDULED_AUDIT_TASK_TYPE,
})
export const SCHEDULED_AUDIT_NODE_GOAL = "Return the exact report from the authenticated scheduled Audit continuation after Gate completion." as const
export const SCHEDULED_AUDIT_NODE_CRITERIA = Object.freeze([
  "Continue the exact scheduled execution only after its canonical Gate proof is verified.",
  "Return only the fixed seven-field report without adding actions or interpreting historical counts.",
  "Never submit applications or invoke model or tool runtimes.",
])

const REPORT_KEYS = ["processed", "applied", "queued", "pending", "skipped", "failed", "durationMs"] as const

export type ScheduledAuditReport = Readonly<{
  processed: number
  applied: number
  queued: number
  pending: number
  skipped: number
  failed: number
  durationMs: number
}>
export type ScheduledAuditTaskEnvelope = Readonly<{
  finalItemId: null
  finalText: ""
  status: "completed"
  stepCount: 0
  toolCallCount: 0
  taskGraphVerificationReport: null
  structuredResult: ScheduledAuditReport
}>
export type ScheduledAuditOwner = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  rootAttemptCount: number
  executionId: string
  executionAttemptCount: number
}>
export type ScheduledAuditAppendReceipt = TaskGraphScheduleReceipt & Readonly<{
  auditTaskId: string
  /** Current or next worker lease attempt derived from the persisted child row. */
  expectedAttemptCount: number
}>
export type ScheduledAuditCompletionProof = Readonly<{
  schemaVersion: typeof SCHEDULED_AUDIT_COMPLETION_PROOF_SCHEMA
  owner: ScheduledAuditOwner
  snapshotDigest: string
  graphRevision: number
  gateProof: ScheduledGateCompletionProof
  audit: Readonly<{ taskId: string; attemptCount: number; resultDigest: string; completedEventRevision: number }>
  report: ScheduledAuditReport
}>
export type ScheduledAuditInvocationProof = Readonly<{
  schemaVersion: typeof SCHEDULED_AUDIT_INVOCATION_PROOF_SCHEMA
  owner: ScheduledAuditOwner
  snapshotDigest: string
  attestation: ScheduledAutomationPipelineAttestation
  prepareProof: ScheduledGateCompletionProof["prepareProof"]
  gateProof: ScheduledGateCompletionProof
  scheduledWaitId: string | null
  auditTaskId: string
  attemptCount: number
  graphRevision: number
}>
export type ScheduledAuditRegistrationReceipt = Readonly<{
  schemaVersion: typeof SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA
  owner: ScheduledAuditOwner
  continuationKey: string
  snapshotDigest: string
  evidenceDigest: string
  checkpointDigest: string
  analyzeGraphRevision: number
  prepareScheduleRevision: number
  prepareWaitId: string
  gateTaskId: string
  gateAttemptCount: number
  gateResultDigest: string
  gateCompletedEventRevision: number
  gateProofDigest: string
  scheduledWaitId: string | null
  auditTaskId: string
  gateGraphRevision: number
  auditAppendRevision: number
  expectedAttemptCount: 1
}>
export type TaskGraphScheduledAuditInput = Readonly<{
  scope: TaskGraphExecutionScope
  executionOwner: ScheduledTaskGraphExecutionOwner
  handoff: ScheduledAnalyzeCheckpointHandoff
  attestation: ScheduledAutomationPipelineAttestation
  gateProof: ScheduledGateCompletionProof
  scheduledWaitId?: string
}>
export type ScheduledAuditInvocationScope = Readonly<Pick<TaskGraphReadScope, "userId" | "sessionId" | "turnId" | "rootTaskId">>
export type TaskGraphScheduledAuditInvocationInput = Readonly<{
  scope: ScheduledAuditInvocationScope
  auditTaskId: string
  attemptCount: number
  attestation: ScheduledAutomationPipelineAttestation
}>
export type TaskGraphScheduledAuditCompletionInput = Readonly<{
  scope: TaskGraphReadScope
  executionOwner: ScheduledTaskGraphExecutionOwner
  gateProof: ScheduledGateCompletionProof
  auditTaskId: string
  attemptCount: number
}>
export type TaskGraphScheduledAuditResumeInput = Readonly<{ scope: TaskGraphReadScope }>
export type ScheduledAuditResumeContext =
  | Readonly<{ status: "not_registered" | "invalid" }>
  | Readonly<{ status: "gate_continuation"; handoff: ScheduledAnalyzeCheckpointHandoff;
      prepareProof: ScheduledGateCompletionProof["prepareProof"]; scheduledWaitId?: string }>
  | Readonly<{ status: "registered"; auditTaskId: string; auditStatus: "queued" | "retrying" | "running" | "completed";
      expectedAttemptCount: number; owner: ScheduledAuditOwner; executionOwner: ScheduledTaskGraphExecutionOwner;
      snapshotDigest: string; gateProof: ScheduledGateCompletionProof }>

export function scheduledAuditRegistrationReceiptKey(continuationKey: string, auditTaskId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([continuationKey, auditTaskId]), "utf8").digest("hex")
  return `scheduled-audit-binding:${digest}`
}

export function parseScheduledAuditRegistrationReceipt(value: unknown): ScheduledAuditRegistrationReceipt | null {
  const keys = ["schemaVersion", "owner", "continuationKey", "snapshotDigest", "evidenceDigest", "checkpointDigest",
    "analyzeGraphRevision", "prepareScheduleRevision", "prepareWaitId", "gateTaskId", "gateAttemptCount",
    "gateResultDigest", "gateCompletedEventRevision", "gateProofDigest", "scheduledWaitId", "auditTaskId", "gateGraphRevision",
    "auditAppendRevision", "expectedAttemptCount"]
  const row = exactRecord(value, keys), owner = row && exactRecord(row.owner,
    ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"])
  if (!row || !owner || row.schemaVersion !== SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA
    || !["userId", "sessionId", "turnId", "rootTaskId", "executionId"].every(key => validId(owner[key]))
    || !positive(owner.rootAttemptCount) || !nonNegative(owner.executionAttemptCount)
    || !scheduledPipelineContinuationKeyVersion(row.continuationKey)
    || !validDigest(row.snapshotDigest, /^sha256:[a-f0-9]{64}$/) || !validDigest(row.evidenceDigest, /^[a-f0-9]{64}$/)
    || !validDigest(row.checkpointDigest, /^[a-f0-9]{64}$/) || !validDigest(row.gateResultDigest, /^sha256:[a-f0-9]{64}$/)
    || !validDigest(row.gateProofDigest, /^sha256:[a-f0-9]{64}$/)
    || row.scheduledWaitId !== null && !validId(row.scheduledWaitId)
    || ![row.prepareWaitId, row.gateTaskId, row.auditTaskId].every(validId)
    || !positive(row.analyzeGraphRevision) || !positive(row.prepareScheduleRevision)
    || !Number.isSafeInteger(Number(row.analyzeGraphRevision) + 1) || row.prepareScheduleRevision !== Number(row.analyzeGraphRevision) + 1
    || !positive(row.gateAttemptCount) || !positive(row.gateGraphRevision) || !positive(row.gateCompletedEventRevision)
    || !positive(row.auditAppendRevision) || !Number.isSafeInteger(Number(row.gateGraphRevision) + 1)
    || row.gateCompletedEventRevision !== row.gateGraphRevision || row.auditAppendRevision !== Number(row.gateGraphRevision) + 1
    || row.expectedAttemptCount !== 1) return null
  return Object.freeze({ ...row, owner: Object.freeze({ ...owner }), expectedAttemptCount: 1 }) as unknown as ScheduledAuditRegistrationReceipt
}

export function parseScheduledAuditReport(value: unknown): ScheduledAuditReport | null {
  const row = exactRecord(value, REPORT_KEYS)
  if (!row || !REPORT_KEYS.every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)) return null
  return Object.fromEntries(REPORT_KEYS.map(key => [key, Number(row[key])])) as unknown as ScheduledAuditReport
}

export function parseScheduledAuditTaskEnvelope(value: unknown, taskStatus: unknown): ScheduledAuditTaskEnvelope | null {
  const row = exactRecord(value, ["finalItemId", "finalText", "status", "stepCount", "toolCallCount", "taskGraphVerificationReport", "structuredResult"])
  const report = row && parseScheduledAuditReport(row.structuredResult)
  if (!row || !report || taskStatus !== "completed" || row.status !== "completed"
    || row.finalItemId !== null || row.finalText !== "" || row.stepCount !== 0 || row.toolCallCount !== 0
    || row.taskGraphVerificationReport !== null) return null
  return { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
    taskGraphVerificationReport: null, structuredResult: report }
}

export function scheduledAuditProposal(expectedRevision: number): TaskGraphProposal {
  return Object.freeze({ expectedRevision, nodes: Object.freeze([Object.freeze({ key: SCHEDULED_AUDIT_TEMPLATE_ID,
    templateId: SCHEDULED_AUDIT_TEMPLATE_ID, goal: SCHEDULED_AUDIT_NODE_GOAL,
    successCriteria: SCHEDULED_AUDIT_NODE_CRITERIA, dependsOn: Object.freeze(["gate"]) })]) })
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
    }
    return value as Record<string, unknown>
  } catch { return null }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function validDigest(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value) }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
