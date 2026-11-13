export type SubmissionEvidenceAvailability = "available" | "unavailable" | "unknown"

export interface ApplicationSubmissionEvidence {
  readonly visible: boolean
  readonly availability: SubmissionEvidenceAvailability
  readonly workerReport: "submitted" | "unknown"
  readonly localRecord: "recorded" | "unknown"
  readonly employerReceipt: "unverified"
}

export interface SubmissionEvidenceTask {
  readonly id: string; readonly userId: string
  readonly jobId: string; readonly sessionId: string | null
  readonly fillTurnId: string | null; readonly fillTurnSessionId: string | null
  readonly fillTurnUserId: string | null; readonly workerTaskId: string | null
  readonly status: string; readonly checkpoint: string | null
}

export type SubmissionEvidenceEventType =
  | "submission_queued"
  | "submission_execution_started"
  | "submission_execution_settled"
  | "submission_evidence_recorded"

export interface SubmissionEvidenceEvent {
  readonly id: string; readonly type: SubmissionEvidenceEventType
  readonly actor: string; readonly data: unknown
}

export interface SubmissionEvidenceApproval {
  readonly id: string; readonly userId: string | null
  readonly sessionId: string | null; readonly taskId: string | null
  readonly turnId: string | null; readonly jobId: string | null
  readonly toolCallId: string | null; readonly type: string
  readonly status: string; readonly scopeHash: string | null
  readonly resourceHash: string | null
}

const MAX_EVENTS = 32
const MAX_APPROVALS = 4
const SUBMISSION_CHECKPOINTS = new Set([
  "submission_request_started",
  "submission_authorized",
  "submission_uncertain",
  "submission_verified",
  "submission_blocked",
  "execution_interrupted",
  "receipt_rejected",
  "queue_retry",
])
const EVIDENCE_RECORD_KEYS = [
  "schemaVersion", "userId", "sessionId", "fillTurnId", "applicationTaskId", "jobId", "approvalId",
  "constraintHash", "workerTaskId", "executionId", "attemptId", "artifactHash", "workerReport", "localRecord", "siteOutcome",
]

type QueueBinding = {
  approvalId: string; receiptId: string
  constraintHash: string; workerTaskId: string
}

type JsonRecord = Record<string, unknown>
type EvidenceRecord = {
  schemaVersion: 1; userId: string; sessionId: string; fillTurnId: string
  applicationTaskId: string; jobId: string; approvalId: string; constraintHash: string
  workerTaskId: string; executionId: string; attemptId: string; artifactHash: string
  workerReport: "recorded_submitted"; localRecord: "correlated" | "unavailable"; siteOutcome: "unverified"
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function uniqueEventIds(events: readonly SubmissionEvidenceEvent[]): boolean {
  const ids = events.map(event => event.id)
  return ids.every(nonEmptyString) && new Set(ids).size === ids.length
}

function isTaskIdentityBound(task: SubmissionEvidenceTask): boolean {
  return [
    task.id, task.userId, task.jobId, task.sessionId, task.fillTurnId,
    task.fillTurnSessionId, task.fillTurnUserId, task.workerTaskId,
  ].every(nonEmptyString) && task.fillTurnSessionId === task.sessionId && task.fillTurnUserId === task.userId
}

function isContradictoryTaskState(task: SubmissionEvidenceTask): boolean {
  return (task.status === "submitted") !== (task.checkpoint === "submission_verified")
}

function isSubmissionContext(task: SubmissionEvidenceTask, events: readonly SubmissionEvidenceEvent[]): boolean {
  return task.status === "submitted" || SUBMISSION_CHECKPOINTS.has(task.checkpoint ?? "") ||
    events.some(event => event.type === "submission_queued" || event.type === "submission_execution_started" ||
      event.type === "submission_execution_settled" || event.type === "submission_evidence_recorded")
}

function parseQueueBinding(task: SubmissionEvidenceTask, events: readonly SubmissionEvidenceEvent[]): QueueBinding | null {
  if (events.length > MAX_EVENTS || !uniqueEventIds(events) || !isTaskIdentityBound(task) || isContradictoryTaskState(task)) return null
  const queued = events.filter(event => event.type === "submission_queued")
  if (queued.length !== 1 || queued[0].actor !== "user") return null

  const data = queued[0].data
  if (!isRecord(data)) return null
  const applicationTaskId = data.applicationTaskId
  const userId = data.userId
  const jobId = data.jobId
  const sessionId = data.sessionId
  const fillTurnId = data.fillTurnId
  const approvalId = data.approvalId
  const receiptId = data.receiptId
  const constraintHash = data.constraintHash
  const workerTaskId = data.workerTaskId
  if (!nonEmptyString(applicationTaskId) || !nonEmptyString(userId) || !nonEmptyString(jobId) ||
      !nonEmptyString(sessionId) || !nonEmptyString(fillTurnId) || !nonEmptyString(approvalId) ||
      !nonEmptyString(receiptId) || !nonEmptyString(constraintHash) || !nonEmptyString(workerTaskId)) return null
  if (applicationTaskId !== task.id || userId !== task.userId || jobId !== task.jobId || sessionId !== task.sessionId ||
      fillTurnId !== task.fillTurnId || workerTaskId !== task.workerTaskId || approvalId !== receiptId) return null

  return { approvalId, receiptId, constraintHash, workerTaskId }
}

function executionMatches(
  event: SubmissionEvidenceEvent,
  task: SubmissionEvidenceTask,
  queue: QueueBinding,
  executionId?: string,
): string | null {
  if (event.actor !== "worker" || !isRecord(event.data)) return null
  const data = event.data
  const currentExecutionId = data.executionId
  const workerTaskId = data.workerTaskId
  const applicationTaskId = data.applicationTaskId
  const userId = data.userId
  const jobId = data.jobId
  const sessionId = data.sessionId
  const fillTurnId = data.fillTurnId
  const approvalId = data.approvalId
  const constraintHash = data.constraintHash
  if (!nonEmptyString(currentExecutionId) || !nonEmptyString(workerTaskId) || !nonEmptyString(applicationTaskId) ||
      !nonEmptyString(userId) || !nonEmptyString(jobId) || !nonEmptyString(sessionId) ||
      !nonEmptyString(fillTurnId) || !nonEmptyString(approvalId) || !nonEmptyString(constraintHash)) return null
  if (workerTaskId !== queue.workerTaskId || applicationTaskId !== task.id || userId !== task.userId ||
      jobId !== task.jobId || sessionId !== task.sessionId || fillTurnId !== task.fillTurnId ||
      approvalId !== queue.approvalId || constraintHash !== queue.constraintHash ||
      (executionId !== undefined && currentExecutionId !== executionId)) return null
  return currentExecutionId
}

function approvalMatches(approval: SubmissionEvidenceApproval, task: SubmissionEvidenceTask, queue: QueueBinding): boolean {
  return approval.id === queue.approvalId && approval.userId === task.userId && approval.sessionId === task.sessionId &&
    approval.taskId === task.id && approval.turnId === task.fillTurnId && approval.jobId === task.jobId &&
    approval.toolCallId === `application-submit:${task.id}` && approval.type === "submit_application" &&
    approval.status === "consumed" && approval.scopeHash === queue.constraintHash
}

function parseEvidenceRecord(event: SubmissionEvidenceEvent): EvidenceRecord | null {
  if (event.type !== "submission_evidence_recorded" || event.actor !== "worker" || !isRecord(event.data)) return null
  const data = event.data
  if (Object.keys(data).length !== EVIDENCE_RECORD_KEYS.length ||
      !EVIDENCE_RECORD_KEYS.every(key => Object.prototype.hasOwnProperty.call(data, key)) || data.schemaVersion !== 1 ||
      data.workerReport !== "recorded_submitted" || (data.localRecord !== "correlated" && data.localRecord !== "unavailable") ||
      data.siteOutcome !== "unverified") return null
  const identityFields = ["userId", "sessionId", "fillTurnId", "applicationTaskId", "jobId", "approvalId", "constraintHash",
    "workerTaskId", "executionId", "attemptId", "artifactHash"] as const
  if (!identityFields.every(key => nonEmptyString(data[key]))) return null
  return data as unknown as EvidenceRecord
}

function evidenceMatches(
  record: EvidenceRecord,
  task: SubmissionEvidenceTask,
  queue: QueueBinding,
  executionId: string,
  approval: SubmissionEvidenceApproval,
): boolean {
  return record.userId === task.userId && record.sessionId === task.sessionId && record.fillTurnId === task.fillTurnId &&
    record.applicationTaskId === task.id && record.jobId === task.jobId && record.approvalId === queue.approvalId &&
    record.constraintHash === queue.constraintHash && record.workerTaskId === queue.workerTaskId &&
    record.executionId === executionId && record.artifactHash === approval.resourceHash
}

export function unknownApplicationSubmissionEvidence(
  visible: boolean,
  availability: SubmissionEvidenceAvailability,
): ApplicationSubmissionEvidence {
  const boundedAvailability: SubmissionEvidenceAvailability = availability === "available" || availability === "unavailable" || availability === "unknown"
    ? availability
    : "unknown"
  return {
    visible: visible === true,
    availability: boundedAvailability,
    workerReport: "unknown",
    localRecord: "unknown",
    employerReceipt: "unverified",
  }
}

export function evaluateApplicationSubmissionEvidence(input: {
  readonly task: SubmissionEvidenceTask
  readonly events: readonly SubmissionEvidenceEvent[]
  readonly approvals: readonly SubmissionEvidenceApproval[]
}): ApplicationSubmissionEvidence {
  const { task, events, approvals } = input
  const visible = isSubmissionContext(task, events)
  const unknown = (availability: SubmissionEvidenceAvailability = "unknown") =>
    unknownApplicationSubmissionEvidence(visible, availability)

  if (!visible) return unknown("unknown")
  if (approvals.length > MAX_APPROVALS) return unknown("unknown")
  const queue = parseQueueBinding(task, events)
  if (!queue || approvals.length !== 1) return unknown("unknown")

  const approval = approvals[0]
  if (!approvalMatches(approval, task, queue)) return unknown("unknown")

  const starts = events.filter(event => event.type === "submission_execution_started")
  const settled = events.filter(event => event.type === "submission_execution_settled")
  const records = events.filter(event => event.type === "submission_evidence_recorded")
  if (starts.length !== 1 || settled.length !== 1 || records.length !== 1) return unknown("unknown")
  const executionId = executionMatches(starts[0], task, queue)
  if (!executionId) return unknown("unknown")
  if (settled.length === 1 && !executionMatches(settled[0], task, queue, executionId)) return unknown("unknown")
  const record = parseEvidenceRecord(records[0])
  if (!record || !evidenceMatches(record, task, queue, executionId, approval)) return unknown("unknown")

  if (task.status !== "submitted" || task.checkpoint !== "submission_verified") return unknown("unknown")

  return {
    visible: true,
    availability: "available",
    workerReport: "submitted",
    localRecord: record.localRecord === "correlated" ? "recorded" : "unknown",
    employerReceipt: "unverified",
  }
}
