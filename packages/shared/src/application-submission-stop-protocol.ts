import { createHash } from "node:crypto"

export const APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA = "agent-harness.v2.application-submission-stop.v1" as const

export const APPLICATION_SUBMISSION_STOP_STAGES = ["armed", "stop_requested", "dispatch_granted"] as const
export type ApplicationSubmissionStopStage = typeof APPLICATION_SUBMISSION_STOP_STAGES[number]

export type ApplicationSubmissionStopAttempt = Readonly<{
  sessionId: string
  fillTurnId: string
  applicationTaskId: string
  userId: string
  jobId: string
  approvalId: string
  receiptId: string
  constraintHash: string
  workerTaskId: string
  executionId: string
}>

export type ApplicationSubmissionStopRecord = ApplicationSubmissionStopAttempt & Readonly<{
  schemaVersion: typeof APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA
  stage: ApplicationSubmissionStopStage
}>

const RECORD_KEYS = [
  "schemaVersion", "stage", "sessionId", "fillTurnId", "applicationTaskId", "userId", "jobId",
  "approvalId", "receiptId", "constraintHash", "workerTaskId", "executionId",
] as const

/** Parse a persisted record without accepting inherited, accessor, extra, or noncanonical fields. */
export function parseApplicationSubmissionStopRecord(value: unknown): ApplicationSubmissionStopRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== RECORD_KEYS.length || keys.some(key => typeof key !== "string" || !RECORD_KEYS.includes(key as typeof RECORD_KEYS[number]))) return null
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null
  }

  const row = value as Record<string, unknown>
  if (row.schemaVersion !== APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA
    || !APPLICATION_SUBMISSION_STOP_STAGES.some(stage => row.stage === stage)
    || typeof row.constraintHash !== "string" || !/^[a-f0-9]{64}$/.test(row.constraintHash)
    || row.approvalId !== row.receiptId) return null
  for (const key of ["sessionId", "fillTurnId", "applicationTaskId", "userId", "jobId", "approvalId", "receiptId", "workerTaskId", "executionId"] as const) {
    const field = row[key]
    if (typeof field !== "string" || field.length === 0 || field.trim() !== field) return null
  }

  return Object.freeze({
    schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
    stage: row.stage as ApplicationSubmissionStopStage,
    sessionId: row.sessionId as string,
    fillTurnId: row.fillTurnId as string,
    applicationTaskId: row.applicationTaskId as string,
    userId: row.userId as string,
    jobId: row.jobId as string,
    approvalId: row.approvalId as string,
    receiptId: row.receiptId as string,
    constraintHash: row.constraintHash,
    workerTaskId: row.workerTaskId as string,
    executionId: row.executionId as string,
  })
}

/** Match one server-owned attempt across its armed, Stop, and grant records. */
export function matchesExactApplicationSubmissionStopAttempt(
  value: unknown,
  expected: ApplicationSubmissionStopAttempt,
): boolean {
  const record = parseApplicationSubmissionStopRecord(value)
  return !!record
    && record.sessionId === expected.sessionId
    && record.fillTurnId === expected.fillTurnId
    && record.applicationTaskId === expected.applicationTaskId
    && record.userId === expected.userId
    && record.jobId === expected.jobId
    && record.approvalId === expected.approvalId
    && record.receiptId === expected.receiptId
    && record.constraintHash === expected.constraintHash
    && record.workerTaskId === expected.workerTaskId
    && record.executionId === expected.executionId
}

export type ApplicationSubmissionStopEventKey = Omit<ApplicationSubmissionStopAttempt, "executionId">

/** Stable per-stage server key; executionId stays in the record so a new execution cannot reuse this receipt. */
export function applicationSubmissionStopEventId(
  key: ApplicationSubmissionStopEventKey,
  stage: ApplicationSubmissionStopStage,
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
    key.userId, key.sessionId, key.fillTurnId, key.applicationTaskId, key.jobId,
    key.approvalId, key.receiptId, key.constraintHash, key.workerTaskId, stage,
  ])).digest("hex")
  return `application-stop-v1-${stage}-${digest}`
}
