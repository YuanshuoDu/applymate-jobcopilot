import type { Pool, PoolClient } from "pg"
import {
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY, OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE,
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA, objectiveApplicationSubmitResultEventId,
  parseObjectiveApplicationSubmitResultReceipt, readObjectiveApplicationSubmitResultWithClient,
} from "../db/objective-application-submit-result.js"
import { recordSubmissionExecutionSettledWithClient, type ApplicationSubmitIdentity, type ApplicationSubmissionExecution } from "./application-submit-fence.js"
import { withExactSubmissionSourceWrite } from "../db/submission-guard.js"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"

type Intent = ApplicationSubmitIdentity & Readonly<{ workerTaskId: string }>
type Client = Pick<PoolClient, "query">
type Row = Record<string, unknown>
export type ObjectiveSubmitTerminalKind = "queue_terminal" | "terminal_callback" | "persisted_terminal_proof"
export type ObjectiveSubmitRecoveryResult = "not_objective" | "not_recovered" | "already_settled" | "recovered" | "superseded"

export const OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE = "objective_application_submit_result_recovered" as const
export const OBJECTIVE_SUBMIT_RECOVERY_EVENT_SCHEMA = "agent-harness.v2.objective-application-submit-recovery.v1" as const
const EVENT_BODY = "Objective browser-confirmed result recovered."
const RECOVERY_PREFIX = "objective-application-submit-result-recovered:"
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const HEX = /^[a-f0-9]{64}$/

/** Hint only; the source-fenced transaction always reloads and validates the immutable result. */
export async function hasObjectiveSubmitResultCandidate(pool: Pool, intent: Intent): Promise<boolean> {
  if (!validIntent(intent)) return false
  const client = await pool.connect(); let open = false
  try {
    await client.query("BEGIN"); open = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", intent.userId])
    const found = await hasObjectiveSubmitResultCandidateWithClient(client, intent)
    await client.query("COMMIT"); open = false
    return found
  } catch (error: unknown) {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

/** Rechecks the candidate hint inside an already source-fenced transaction. */
export async function hasObjectiveSubmitResultCandidateWithClient(client: Client, intent: Intent): Promise<boolean> {
  if (!validIntent(intent)) return false
  const rows = await client.query(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1
    AND ("id"=$2 OR ("type"=$3 AND "data"->>'fillTurnId'=$4)) LIMIT 2`, [intent.applicationTaskId,
    objectiveApplicationSubmitResultEventId({ applicationTaskId: intent.applicationTaskId, fillTurnId: intent.fillTurnId, approvalId: intent.approvalId }),
    OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, intent.fillTurnId])
  return rows.rows.length > 0
}

/** Repairs only the immutable Stage1 success under the same source and attempt fences. */
export async function recoverObjectiveSubmitAfterTerminal(pool: Pool, intent: Intent,
  observe: (client: PoolClient) => Promise<ObjectiveSubmitTerminalKind | null>): Promise<ObjectiveSubmitRecoveryResult> {
  if (!validIntent(intent)) return "not_objective"
  const outcome = await withExactSubmissionSourceWrite(pool, identityFor(intent), "objective_submit_terminal_recovery", async client => {
    const terminalKind = await observe(client)
    if (!terminalKind) return "not_recovered" as const
    return repairWithClient(client, intent, terminalKind)
  })
  return outcome.kind === "superseded" ? "superseded" : outcome.value
}

async function repairWithClient(client: Client, intent: Intent, terminalKind: ObjectiveSubmitTerminalKind): Promise<ObjectiveSubmitRecoveryResult> {
  const candidateId = objectiveApplicationSubmitResultEventId({ applicationTaskId: intent.applicationTaskId,
    fillTurnId: intent.fillTurnId, approvalId: intent.approvalId })
  const rows = await client.query<Row>(`SELECT "id","taskId","type","actor","body","data","createdAt" FROM "application_task_events"
    WHERE "taskId"=$1 AND ("id"=$2 OR ("type"=$3 AND "data"->>'fillTurnId'=$4)) LIMIT 2`,
  [intent.applicationTaskId, candidateId, OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE, intent.fillTurnId])
  const event = rows.rows[0], stored = parseObjectiveApplicationSubmitResultReceipt(event?.data)
  if (!stored) return rows.rows.length === 0 ? "not_objective" : "not_recovered"
  const execution = executionFor(stored)
  if (rows.rows.length !== 1 || !event || event.id !== candidateId || event.taskId !== intent.applicationTaskId
    || event.type !== OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_TYPE || event.actor !== "worker"
    || event.body !== OBJECTIVE_APPLICATION_SUBMIT_RESULT_EVENT_BODY || !sameIntent(stored, intent)) return "not_recovered"
  const receipt = await readObjectiveApplicationSubmitResultWithClient(client, execution)
  if (!receipt || receipt.schemaVersion !== OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA || receipt.eventId !== candidateId
    || !sameIntent(receipt, intent) || receipt.executionId !== stored.executionId || receipt.attemptId !== stored.attemptId
    || receipt.applyResultId !== stored.applyResultId) return "not_recovered"
  const taskRows = await client.query<Row>(`SELECT "id","userId","jobId","sessionId","fillTurnId","fillTurnSessionId","fillTurnUserId",
    "workerTaskId","status","checkpoint","completedAt" FROM "application_tasks" WHERE "id"=$1 AND "userId"=$2
      AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5 AND "fillTurnSessionId"=$4 AND "fillTurnUserId"=$2
      AND "workerTaskId"=$6 LIMIT 2 FOR UPDATE`, [intent.applicationTaskId, intent.userId, intent.jobId, intent.sessionId,
    intent.fillTurnId, intent.workerTaskId])
  const jobRows = await client.query<Row>(`SELECT "id","userId","status","workflowState","appliedAt" FROM "Job"
    WHERE "id"=$1 AND "userId"=$2 LIMIT 2 FOR UPDATE`, [intent.jobId, intent.userId])
  const task = taskRows.rows[0], job = jobRows.rows[0]
  if (taskRows.rows.length !== 1 || jobRows.rows.length !== 1 || !task || !job || !sameTask(task, intent) || !taskState(task)
    || !jobState(job, intent)) return "not_recovered"
  const [settled, audit] = await Promise.all([readSettled(client, intent, execution, receipt.eventCreatedAt, receipt.eventId), readRecoveryAudit(client, intent, receipt)])
  if (settled === "invalid" || audit === "invalid" || audit === "present" && settled !== "present") return "not_recovered"
  const projectionsComplete = task.status === "submitted" && job.status === "applied"
  if (settled === "present" && projectionsComplete) return "already_settled"
  if (settled === "present" && audit === "present") return "not_recovered"
  if (job.status === "saved") {
    const jobWrite = await client.query(`UPDATE "Job" SET "status"='applied',"workflowState"='submitted',
      "appliedAt"=COALESCE("appliedAt",NOW()),"updatedAt"=NOW() WHERE "id"=$1 AND "userId"=$2
        AND "status"='saved' AND "workflowState"='submitting' RETURNING "id"`, [intent.jobId, intent.userId])
    if (jobWrite.rowCount !== 1) throw new Error("objective_submit_recovery_job_cas_failed")
  }
  if (task.status !== "submitted") {
    const taskWrite = await client.query(`UPDATE "application_tasks" SET "status"='submitted',"checkpoint"='submission_verified',
      "error"=NULL,"completedAt"=COALESCE("completedAt",NOW()),"updatedAt"=NOW() WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3
        AND "sessionId"=$4 AND "fillTurnId"=$5 AND "workerTaskId"=$6 AND (
          ("status"='filling' AND "checkpoint"='submission_request_started') OR
          ("status"='waiting_for_user' AND "checkpoint"='submission_uncertain')) RETURNING "id"`,
    [intent.applicationTaskId, intent.userId, intent.jobId, intent.sessionId, intent.fillTurnId, intent.workerTaskId])
    if (taskWrite.rowCount !== 1) throw new Error("objective_submit_recovery_task_cas_failed")
  }
  const auditData = { schemaVersion: OBJECTIVE_SUBMIT_RECOVERY_EVENT_SCHEMA, ...execution,
    attemptId: receipt.attemptId, resultLinkEventId: receipt.eventId, applyResultId: receipt.applyResultId,
    terminalObservationKind: terminalKind }
  const inserted = await client.query(`INSERT INTO "application_task_events" ("id","taskId","type","actor","body","data","createdAt")
    VALUES ($1,$2,$3,'worker',$4,$5::jsonb,NOW()) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
  [recoveryEventId(intent, receipt), intent.applicationTaskId, OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE, EVENT_BODY, JSON.stringify(auditData)])
  if (inserted.rowCount !== 1) throw new Error("objective_submit_recovery_audit_conflict")
  if (settled === "absent" && !await recordSubmissionExecutionSettledWithClient(client as PoolClient, execution)) throw new Error("objective_submit_recovery_settlement_missing")
  return "recovered"
}

async function readSettled(client: Client, intent: Intent, execution: ApplicationSubmissionExecution,
  resultCreatedAt: Date | string, resultEventId: string): Promise<"absent" | "present" | "invalid"> {
  const rows = await client.query<Row>(`SELECT "id","actor","body","data","createdAt" FROM "application_task_events" WHERE "taskId"=$1
    AND "type"='submission_execution_settled' AND ("data"->>'workerTaskId'=$2 OR "data"->>'executionId'=$3 OR "id"=$4) LIMIT 2`,
  [intent.applicationTaskId, intent.workerTaskId, execution.executionId, `evt_${execution.executionId}`])
  if (rows.rows.length === 0) return "absent"
  return rows.rows.length === 1 && exactSettled(rows.rows[0], execution, resultCreatedAt, resultEventId) ? "present" : "invalid"
}

async function readRecoveryAudit(client: Client, intent: Intent, receipt: { eventId: string; executionId: string; attemptId: string; applyResultId: number }): Promise<"absent" | "present" | "invalid"> {
  const eventId = recoveryEventId(intent, receipt)
  const rows = await client.query<Row>(`SELECT "id","taskId","type","actor","body","data" FROM "application_task_events" WHERE "taskId"=$1
    AND ("id"=$2 OR ("type"=$3 AND "data"->>'resultLinkEventId'=$4 AND "data"->>'executionId'=$5)) LIMIT 2`,
  [intent.applicationTaskId, eventId, OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE, receipt.eventId, receipt.executionId])
  if (rows.rows.length === 0) return "absent"
  const event = rows.rows[0]
  const data = exactRecord(event?.data, ["schemaVersion","executionId","workerTaskId","applicationTaskId","userId","jobId","sessionId",
    "fillTurnId","approvalId","constraintHash","attemptId","resultLinkEventId","applyResultId","terminalObservationKind"])
  const expected = executionRecord({ ...identityFor(intent), workerTaskId: intent.workerTaskId, executionId: receipt.executionId })
  return rows.rows.length === 1 && event?.id === eventId && event?.taskId === intent.applicationTaskId
    && event.type === OBJECTIVE_SUBMIT_RECOVERY_EVENT_TYPE && event.actor === "worker" && event.body === EVENT_BODY
    && !!data && data.schemaVersion === OBJECTIVE_SUBMIT_RECOVERY_EVENT_SCHEMA
    && Object.entries(expected).every(([key,value]) => data[key] === value)
    && data.attemptId === receipt.attemptId && data.resultLinkEventId === receipt.eventId && data.applyResultId === receipt.applyResultId
    && ["queue_terminal","terminal_callback","persisted_terminal_proof"].includes(String(data.terminalObservationKind))
    ? "present" : "invalid"
}

function exactSettled(value: unknown, x: ApplicationSubmissionExecution, resultCreatedAt: Date | string, resultEventId: string): boolean {
  const row = exactRecord(value, ["id","actor","body","data","createdAt"]), data = row?.data
  const payload = exactRecord(data, ["executionId","workerTaskId","applicationTaskId","userId","jobId","sessionId","fillTurnId","approvalId","constraintHash"])
  const settlementTime = timeValue(row?.createdAt), resultTime = timeValue(resultCreatedAt)
  return !!row && typeof row.id === "string" && /^evt_[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(row.id) && row.id !== resultEventId
    && settlementTime !== null && resultTime !== null && settlementTime >= resultTime
    && row.actor === "worker" && row.body === "Submit execution settled" && !!payload
    && Object.entries(executionRecord(x)).every(([key, expected]) => payload[key] === expected)
}
function timeValue(value: unknown): number | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.getTime() : null
}
function sameTask(task: Row, x: Intent): boolean {
  return task.id === x.applicationTaskId && task.userId === x.userId && task.jobId === x.jobId && task.sessionId === x.sessionId
    && task.fillTurnId === x.fillTurnId && task.fillTurnSessionId === x.sessionId && task.fillTurnUserId === x.userId
    && task.workerTaskId === x.workerTaskId
}
function taskState(task: Row): boolean {
  return task.status === "filling" && task.checkpoint === "submission_request_started" && task.completedAt == null
    || task.status === "submitted" && task.checkpoint === "submission_verified" && task.completedAt != null
    || task.status === "waiting_for_user" && task.checkpoint === "submission_uncertain" && task.completedAt == null
}
function jobState(job: Row, x: Intent): boolean {
  return job.id === x.jobId && job.userId === x.userId && (job.status === "saved" && job.workflowState === "submitting"
    || job.status === "applied" && job.workflowState === "submitted" && job.appliedAt != null)
}
function sameIntent(value: { applicationTaskId: string; userId: string; jobId: string; sessionId: string; fillTurnId: string;
  approvalId: string; constraintHash: string; workerTaskId: string }, x: Intent): boolean {
  return value.applicationTaskId === x.applicationTaskId && value.userId === x.userId && value.jobId === x.jobId
    && value.sessionId === x.sessionId && value.fillTurnId === x.fillTurnId && value.approvalId === x.approvalId
    && value.constraintHash === x.constraintHash && value.workerTaskId === x.workerTaskId
}
function executionFor(value: ReturnType<typeof parseObjectiveApplicationSubmitResultReceipt>): ApplicationSubmissionExecution {
  return { applicationTaskId: value!.applicationTaskId, userId: value!.userId, jobId: value!.jobId,
    sessionId: value!.sessionId, fillTurnId: value!.fillTurnId, approvalId: value!.approvalId,
    constraintHash: value!.constraintHash, workerTaskId: value!.workerTaskId, executionId: value!.executionId }
}
function identityFor(x: Intent): ApplicationSubmitIdentity {
  return { applicationTaskId: x.applicationTaskId, userId: x.userId, jobId: x.jobId, sessionId: x.sessionId,
    fillTurnId: x.fillTurnId, approvalId: x.approvalId, constraintHash: x.constraintHash }
}
function executionRecord(x: ApplicationSubmissionExecution): Row {
  return { executionId: x.executionId, workerTaskId: x.workerTaskId, applicationTaskId: x.applicationTaskId,
    userId: x.userId, jobId: x.jobId, sessionId: x.sessionId, fillTurnId: x.fillTurnId,
    approvalId: x.approvalId, constraintHash: x.constraintHash }
}
function recoveryEventId(x: Intent, receipt: { eventId: string; executionId: string }): string {
  return `${RECOVERY_PREFIX}${hashArtifactContent([x.applicationTaskId, x.fillTurnId, receipt.executionId, receipt.eventId]).slice(7)}`
}
function validIntent(x: Intent): boolean {
  return [x.applicationTaskId,x.userId,x.jobId,x.sessionId,x.fillTurnId,x.approvalId,x.workerTaskId].every(value => typeof value === "string" && ID.test(value))
    && typeof x.constraintHash === "string" && HEX.test(x.constraintHash)
}
function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return null
    const result = Object.create(null) as Row
    for (const key of keys) { const property = Object.getOwnPropertyDescriptor(value, key); if (!property?.enumerable || !Object.hasOwn(property, "value")) return null; result[key] = property.value }
    return result
  } catch { return null }
}
