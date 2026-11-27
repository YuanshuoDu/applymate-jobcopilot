import type { Pool, PoolClient } from "pg"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import {
  bindReviewedApplicationSubmissionMaterial, canonicalJson, hashObjectiveApplicationSubmissionMaterial,
  parseObjectiveReviewedApplicationFillBrowserStartEvent, parseObjectiveReviewedFillSource,
} from "@jobcopilot/shared"
import type { ApplicationSubmitIdentity, ApplicationSubmissionExecution } from "../queue/application-submit-fence.js"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import { insertApplyResultWithClient } from "./apply-results.js"
import { readObjectiveSubmissionManifestWithClient } from "./objective-submission-manifest-event.js"
import { withExactSubmissionWrite } from "./submission-guard.js"
import { protocolScope } from "../runtime/approval/types.js"

type Client = Pick<PoolClient, "query">
type Row = Record<string, unknown>
type Execution = ApplicationSubmissionExecution
type Attempt = { id: string; userId: string; jobId: string; receiptId: string; constraintHash: string; artifactHash: string; state: string; responseRef: string | null }
type Stored = Readonly<{ schemaVersion: typeof OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA; applicationTaskId: string;
  userId: string; jobId: string; sessionId: string; fillTurnId: string; approvalId: string; constraintHash: string;
  workerTaskId: string; executionId: string; attemptId: string; applyResultId: number }>
export type ObjectiveApplicationSubmitResultReceipt = Stored & Readonly<{ eventId: string; eventCreatedAt: Date | string }>

export const OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA = "agent-harness.v2.objective-application-submit-result.v1" as const
export const OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE = "objective_application_submit_result_recorded" as const
export const OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY = "Objective browser-confirmed result recorded." as const
const HEX = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Records only a successful Objective browser request with its exact historical V3 authority. */
export async function recordObjectiveApplicationSubmitResult(input: {
  pool: Pool; execution: Execution; runnerStatus: string; confirmationId: string | null; durationMs: number;
  requestStarted: boolean; requestContinued: boolean; fenceUnavailable: boolean;
}): Promise<{ readonly kind: "recorded"; readonly resultId: number } | { readonly kind: "invalid" | "superseded" }> {
  const { execution } = input
  if (!validExecution(execution) || input.runnerStatus !== "submitted" || !input.requestStarted || !input.requestContinued
    || input.fenceUnavailable || typeof input.confirmationId !== "string" || !ID.test(input.confirmationId)
    || !Number.isSafeInteger(input.durationMs) || input.durationMs < 0) return { kind: "invalid" }
  const outcome = await withExactSubmissionWrite(input.pool, execution, "objective_submit_success_result", async client => {
    const prior = await readObjectiveApplicationSubmitResultWithClient(client, execution)
    if (prior) return prior.applyResultId
    const logical = await client.query<Row>(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1
      AND ("id"=$2 OR ("type"=$3 AND "data"->>'fillTurnId'=$4)) LIMIT 2`,
    [execution.applicationTaskId, objectiveApplicationSubmitResultEventId(execution), OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, execution.fillTurnId])
    if (logical.rows.length) return null
    const basis = await readHistoricalBasis(client, execution)
    if (!basis || basis.attempt.responseRef !== input.confirmationId || !await newRequestIsCurrent(client, execution)) return null
    const result = await insertApplyResultWithClient(client, { userId: execution.userId, jobId: execution.jobId,
      mode: "unattended", atsType: "greenhouse", flowUsed: "application.submit", status: "submitted", error: null,
      durationMs: input.durationMs })
    if (!Number.isSafeInteger(result) || result < 1) throw new Error("Objective submit result id is invalid.")
    const receipt = receiptFor(execution, basis.attempt.id, result)
    const inserted = await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
      VALUES ($1,$2,$3,'worker',$4,$5::jsonb,NOW()) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
    [objectiveApplicationSubmitResultEventId(execution), execution.applicationTaskId, OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE,
      OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY, JSON.stringify(receipt)])
    if (inserted.rowCount !== 1) throw new Error("Objective submit result event conflicted.")
    return result
  })
  if (outcome.kind === "superseded") return { kind: "superseded" }
  return outcome.value === null ? { kind: "invalid" } : { kind: "recorded", resultId: outcome.value }
}

/** Reads a fully linked immutable result; settlement and terminality remain caller-owned checks. */
export async function readObjectiveApplicationSubmitResultWithClient(client: Client, execution: Execution): Promise<
  ObjectiveApplicationSubmitResultReceipt | null> {
  if (!validExecution(execution)) return null
  const rows = await client.query<Row>(`SELECT "id", "taskId", "type", "actor", "body", "data", "createdAt" FROM "application_task_events"
    WHERE "taskId"=$1 AND ("id"=$2 OR ("type"=$3 AND "data"->>'fillTurnId'=$4)) LIMIT 2`,
  [execution.applicationTaskId, objectiveApplicationSubmitResultEventId(execution), OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, execution.fillTurnId])
  const row = rows.rows[0], receipt = parseObjectiveApplicationSubmitResultReceipt(row?.data)
  if (rows.rows.length !== 1 || !row || row.id !== objectiveApplicationSubmitResultEventId(execution)
    || row.taskId !== execution.applicationTaskId || row.type !== OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE
    || row.actor !== "worker" || row.body !== OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY || !toDate(row.createdAt)
    || !receipt || !sameExecution(receipt, execution)) return null
  const basis = await readHistoricalBasis(client, execution, receipt.attemptId)
  if (!basis) return null
  const result = await client.query<Row>(`SELECT id, user_id AS "userId", job_id AS "jobId", mode,
    ats_type AS "atsType", flow_used AS "flowUsed", status, error FROM apply_results WHERE id=$1 LIMIT 2`, [receipt.applyResultId])
  const applied = result.rows[0]
  if (result.rows.length !== 1 || !applied || Number(applied.id) !== receipt.applyResultId
    || applied.userId !== execution.userId || applied.jobId !== execution.jobId || applied.mode !== "unattended"
    || applied.atsType !== "greenhouse" || applied.flowUsed !== "application.submit" || applied.status !== "submitted"
    || applied.error !== null) return null
  return { ...receipt, eventId: row.id as string, eventCreatedAt: row.createdAt as Date | string }
}

export function parseObjectiveApplicationSubmitResultReceipt(value: unknown): Stored | null {
  const row = exactRecord(value, ["schemaVersion", "applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId",
    "approvalId", "constraintHash", "workerTaskId", "executionId", "attemptId", "applyResultId"])
  if (!row || row.schemaVersion !== OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA
    || ![row.applicationTaskId, row.userId, row.jobId, row.sessionId, row.fillTurnId, row.approvalId, row.workerTaskId,
      row.executionId, row.attemptId].every(value => typeof value === "string" && ID.test(value))
    || typeof row.constraintHash !== "string" || !HEX.test(row.constraintHash)
    || !Number.isSafeInteger(row.applyResultId) || Number(row.applyResultId) < 1) return null
  return Object.freeze({ schemaVersion: OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA, applicationTaskId: row.applicationTaskId as string,
    userId: row.userId as string, jobId: row.jobId as string, sessionId: row.sessionId as string, fillTurnId: row.fillTurnId as string,
    approvalId: row.approvalId as string, constraintHash: row.constraintHash, workerTaskId: row.workerTaskId as string,
    executionId: row.executionId as string, attemptId: row.attemptId as string, applyResultId: Number(row.applyResultId) })
}

export function objectiveApplicationSubmitResultEventId(execution: Pick<Execution, "applicationTaskId" | "fillTurnId" | "approvalId">): string {
  return `objective-application-submit-result:${hashArtifactContent([execution.applicationTaskId, execution.fillTurnId, execution.approvalId]).slice(7)}`
}

async function readHistoricalBasis(client: Client, execution: Execution, expectedAttemptId?: string): Promise<{ attempt: Attempt } | null> {
  const task = await client.query<Row>(`SELECT task."workerTaskId", turn."input" AS "turnInput" FROM "application_tasks" AS task
    JOIN "agent_turns" AS turn ON turn."id"=task."fillTurnId" AND turn."sessionId"=task."fillTurnSessionId" AND turn."userId"=task."fillTurnUserId"
    WHERE task."id"=$1 AND task."userId"=$2 AND task."jobId"=$3 AND task."sessionId"=$4 AND task."fillTurnId"=$5
      AND task."fillTurnSessionId"=$4 AND task."fillTurnUserId"=$2 AND turn."id"=$5 LIMIT 2 FOR SHARE OF task`,
  [execution.applicationTaskId, execution.userId, execution.jobId, execution.sessionId, execution.fillTurnId])
  if (task.rows.length !== 1 || task.rows[0]?.workerTaskId !== execution.workerTaskId) return null
  const scope = { userId: execution.userId, sessionId: execution.sessionId, applicationTaskId: execution.applicationTaskId,
    jobId: execution.jobId, fillTurnId: execution.fillTurnId }
  const [approval, attempt, manifestPacket, start] = await Promise.all([
    readApproval(client, execution), readAttempt(client, execution, expectedAttemptId),
    readObjectiveSubmissionManifestWithClient(client, scope), readStart(client, execution),
  ])
  if (!approval || !attempt || !manifestPacket || !start || attempt.artifactHash !== approval.resourceHash) return null
  const browser = await readBrowserStart(client, execution, manifestPacket.manifest)
  if (!browser || !isBefore(browser.createdAt, start.createdAt)) return null
  const { manifest, hash } = manifestPacket
  const source = parseObjectiveReviewedFillSource(task.rows[0]?.turnInput)
  if (!source || !sameSource(source, manifest.material.objectiveSource) || !sameSource(source, browser.binding.objectiveSource)
    || hash !== `sha256:${approval.resourceHash}` || manifest.answersHash !== approval.answersHash) return null
  const materialHash = await hashObjectiveApplicationSubmissionMaterial(manifest.material)
  const bound = await bindReviewedApplicationSubmissionMaterial({ applicationTaskId: execution.applicationTaskId, jobId: execution.jobId,
    resumeId: manifest.material.resumeId, coverLetterId: manifest.material.coverLetterId }, browser.binding.proof)
  const payload = plainRecord(approval.payload)
  if (!materialHash || materialHash !== approval.materialHash || !bound
    || bound.reviewedCoverLetterHash !== manifest.material.reviewedCoverLetterHash
    || payload?.applicationTaskId !== execution.applicationTaskId || payload.jobId !== execution.jobId
    || payload.resumeId !== manifest.material.resumeId || payload.coverLetterId !== manifest.material.coverLetterId) return null
  return { attempt }
}

async function readApproval(client: Client, x: Execution): Promise<Row | null> {
  const found = await client.query<Row>(`SELECT "id", "userId", "sessionId", "taskId", "turnId", "toolCallId", "jobId", "type", "status",
    "payload", "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt", "decidedAt", "consumedAt" FROM "agent_approvals"
    WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 AND "taskId"=$4 AND "turnId"=$5 AND "jobId"=$6 LIMIT 2 FOR SHARE`,
  [x.approvalId, x.userId, x.sessionId, x.applicationTaskId, x.fillTurnId, x.jobId])
  const row = found.rows[0]
  if (found.rows.length !== 1 || !row || row.id !== x.approvalId || row.userId !== x.userId || row.sessionId !== x.sessionId
    || row.taskId !== x.applicationTaskId || row.turnId !== x.fillTurnId || row.jobId !== x.jobId
    || row.toolCallId !== `application-submit:${x.applicationTaskId}` || row.type !== "submit_application"
    || row.status !== "consumed" || row.consumedAt == null || row.scopeHash !== x.constraintHash) return null
  const expiresAt = toDate(row.expiresAt), decidedAt = toDate(row.decidedAt), consumedAt = toDate(row.consumedAt)
  if (!expiresAt || !decidedAt || !consumedAt || decidedAt > consumedAt || consumedAt >= expiresAt
    || typeof row.resourceHash !== "string" || !HEX.test(row.resourceHash)
    || typeof row.materialHash !== "string" || !HEX.test(row.materialHash)
    || typeof row.answersHash !== "string" || !HEX.test(row.answersHash)
    || typeof row.nonceHash !== "string" || !HEX.test(row.nonceHash)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) return null
  const scope = protocolScope({ userId: x.userId, sessionId: x.sessionId, turnId: x.fillTurnId, jobId: x.jobId,
    toolCallId: `application-submit:${x.applicationTaskId}`, action: "submit_application", resourceHash: row.resourceHash,
    materialHash: row.materialHash, answersHash: row.answersHash, revision: Number(row.revision), expiresAt }, row.nonceHash)
  return await hashApprovalScope(scope) === row.scopeHash ? row : null
}

async function readAttempt(client: Client, x: Execution, expectedId?: string): Promise<Attempt | null> {
  const found = await client.query<Attempt & Row>(`SELECT "id", "userId", "jobId", "receiptId", "constraintHash", "artifactHash", "state", "responseRef"
    FROM "submission_attempt" WHERE "userId"=$1 AND "jobId"=$2 AND "receiptId"=$3 AND "constraintHash"=$4 LIMIT 2 FOR UPDATE`,
  [x.userId, x.jobId, x.approvalId, x.constraintHash])
  const row = found.rows[0]
  return found.rows.length === 1 && row && (!expectedId || row.id === expectedId) && ID.test(row.id)
    && row.userId === x.userId && row.jobId === x.jobId && row.receiptId === x.approvalId && row.constraintHash === x.constraintHash
    && typeof row.artifactHash === "string" && HEX.test(row.artifactHash)
    && row.state === "submitted" && typeof row.responseRef === "string" && ID.test(row.responseRef) ? row : null
}

async function readBrowserStart(client: Client, x: Execution, manifest: NonNullable<Awaited<ReturnType<typeof readObjectiveSubmissionManifestWithClient>>>["manifest"]) {
  const event = await client.query<Row>(`SELECT "id", "taskId", "type", "actor", "body", "data", "createdAt" FROM "application_task_events"
    WHERE "taskId"=$1 AND "type"='reviewed_application_fill_browser_started' AND "data"->>'fillTurnId'=$2 LIMIT 2`, [x.applicationTaskId, x.fillTurnId])
  const row = event.rows[0], binding = parseObjectiveReviewedApplicationFillBrowserStartEvent(row?.data)
  const expiry = binding ? new Date(binding.leaseExpiresAt) : null
  const at = row ? toDate(row.createdAt) : null
  if (event.rows.length !== 1 || !row || row.taskId !== x.applicationTaskId || row.type !== "reviewed_application_fill_browser_started"
    || row.actor !== "worker" || row.body !== "Reviewed application material bound to browser-start attempt."
    || !binding || binding.userId !== x.userId || binding.sessionId !== x.sessionId
    || binding.fillTurnId !== x.fillTurnId || binding.applicationTaskId !== x.applicationTaskId || binding.jobId !== x.jobId
    || !sameSource(binding.objectiveSource, manifest.material.objectiveSource)
    || !at || !expiry || at >= expiry) return null
  return { binding, createdAt: at }
}

async function readStart(client: Client, x: Execution): Promise<{ createdAt: unknown } | null> {
  const found = await client.query<Row>(`SELECT "id", "taskId", "type", "actor", "body", "data", "createdAt" FROM "application_task_events"
    WHERE "taskId"=$1 AND "type"='submission_execution_started' AND ("id"=$2 OR "data"->>'workerTaskId'=$3) LIMIT 2`,
  [x.applicationTaskId, `evt_${x.executionId}`, x.workerTaskId])
  const row = found.rows[0], data = exactRecord(row?.data, ["executionId", "workerTaskId", "applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "constraintHash"])
  return found.rows.length === 1 && row && data && row.id === `evt_${x.executionId}` && row.taskId === x.applicationTaskId
    && row.type === "submission_execution_started" && row.actor === "worker" && row.body === "Submit execution started"
    && sameExecution(data, x) ? { createdAt: row.createdAt } : null
}

async function newRequestIsCurrent(client: Client, x: Execution): Promise<boolean> {
  const found = await client.query<Row>(`SELECT "status", "checkpoint" FROM "application_tasks" WHERE "id"=$1 AND "userId"=$2
    AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5 AND "fillTurnSessionId"=$4 AND "fillTurnUserId"=$2 LIMIT 2 FOR SHARE`,
  [x.applicationTaskId, x.userId, x.jobId, x.sessionId, x.fillTurnId])
  return found.rows.length === 1 && found.rows[0]?.status === "filling" && found.rows[0]?.checkpoint === "submission_request_started"
}

function receiptFor(x: Execution, attemptId: string, applyResultId: number): Stored {
  return Object.freeze({ schemaVersion: OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA, applicationTaskId: x.applicationTaskId,
    userId: x.userId, jobId: x.jobId, sessionId: x.sessionId, fillTurnId: x.fillTurnId, approvalId: x.approvalId,
    constraintHash: x.constraintHash, workerTaskId: x.workerTaskId, executionId: x.executionId, attemptId, applyResultId })
}
function sameExecution(row: Row, x: Execution): boolean {
  return row.applicationTaskId === x.applicationTaskId && row.userId === x.userId && row.jobId === x.jobId
    && row.sessionId === x.sessionId && row.fillTurnId === x.fillTurnId && row.approvalId === x.approvalId
    && row.constraintHash === x.constraintHash && row.workerTaskId === x.workerTaskId && row.executionId === x.executionId
}
function sameSource(a: unknown, b: unknown): boolean { try { return !!a && !!b && canonicalJson(a) === canonicalJson(b) } catch { return false } }
function isBefore(a: unknown, b: unknown): boolean { const left = toDate(a), right = toDate(b); return !!left && !!right && left <= right }
function toDate(value: unknown): Date | null { const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date : null }
function validExecution(x: Execution): boolean {
  return [x.applicationTaskId, x.userId, x.jobId, x.sessionId, x.fillTurnId, x.approvalId, x.workerTaskId, x.executionId].every(value => typeof value === "string" && ID.test(value)) && HEX.test(x.constraintHash)
}
function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return null
    const row = Object.create(null) as Row
    for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null; row[key] = descriptor.value }
    return row
  } catch { return null }
}
function plainRecord(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
