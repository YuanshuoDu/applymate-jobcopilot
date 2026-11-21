import type { Pool, PoolClient } from "pg"
import {
  APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
  APPLICATION_SUBMISSION_STOP_STAGES,
  applicationSubmissionStopEventId,
  matchesExactApplicationSubmissionStopAttempt,
  parseApplicationSubmissionStopRecord,
  type ApplicationSubmissionStopAttempt,
  type ApplicationSubmissionStopEventKey,
  type ApplicationSubmissionStopStage,
} from "@jobcopilot/shared/application-submission-stop-protocol"
import { createPgApprovalStore } from "../runtime/approval/pg-store.js"
import type { ApplicationSubmissionStartScope } from "./application-task-state.js"
import { withExactSubmissionClientWrite } from "./submission-guard.js"

export type WorkerSubmissionStopStage = Extract<ApplicationSubmissionStopStage, "armed" | "dispatch_granted">
/** `duplicate` confirms persisted state only; no return value authorizes browser continuation. */
export type WorkerSubmissionStopWrite = "recorded" | "duplicate" | "stopped" | "fenced"

type TaskRow = { status: string; checkpoint: string | null; workerTaskId: string | null }
type AttemptRow = { artifactHash: string; state: string }
type StartEventRow = { taskId: string; type: string; actor: string; data: unknown }
type StopEventRow = { id: string; taskId: string; type: string; actor: string; body: string; data: unknown }

const EVENT_TYPE = "submission_stop_protocol"
const EVENT_BODY = "Application submission Stop protocol state recorded."
const START_DATA_KEYS = "applicationTaskId,approvalId,constraintHash,executionId,fillTurnId,jobId,sessionId,userId,workerTaskId"

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function stopAttempt(scope: ApplicationSubmissionStartScope): ApplicationSubmissionStopAttempt {
  return { sessionId: scope.sessionId, fillTurnId: scope.fillTurnId, applicationTaskId: scope.applicationTaskId,
    userId: scope.userId, jobId: scope.jobId, approvalId: scope.approvalId, receiptId: scope.approvalId,
    constraintHash: scope.constraintHash, workerTaskId: scope.workerTaskId, executionId: scope.executionId }
}

function stopEventKey(attempt: ApplicationSubmissionStopAttempt): ApplicationSubmissionStopEventKey {
  return { sessionId: attempt.sessionId, fillTurnId: attempt.fillTurnId, applicationTaskId: attempt.applicationTaskId,
    userId: attempt.userId, jobId: attempt.jobId, approvalId: attempt.approvalId, receiptId: attempt.receiptId,
    constraintHash: attempt.constraintHash, workerTaskId: attempt.workerTaskId }
}

function matchesStartedEvent(row: StartEventRow | undefined, attempt: ApplicationSubmissionStopAttempt): boolean {
  if (!row || row.taskId !== attempt.applicationTaskId || row.type !== "submission_execution_started" || row.actor !== "worker" || !plainRecord(row.data)) return false
  const data = row.data
  return Object.keys(data).sort().join(",") === START_DATA_KEYS
    && data.applicationTaskId === attempt.applicationTaskId && data.approvalId === attempt.approvalId
    && data.constraintHash === attempt.constraintHash && data.executionId === attempt.executionId
    && data.fillTurnId === attempt.fillTurnId && data.jobId === attempt.jobId
    && data.sessionId === attempt.sessionId && data.userId === attempt.userId && data.workerTaskId === attempt.workerTaskId
}

/** Writes one Worker stage inside the caller's transaction; the caller commits before any request release. */
export async function recordApplicationSubmissionStopStage(
  pool: Pool,
  client: PoolClient,
  scope: ApplicationSubmissionStartScope,
  stage: WorkerSubmissionStopStage,
): Promise<WorkerSubmissionStopWrite> {
  if (scope.turnId !== scope.fillTurnId) return "fenced"
  const attempt = parseApplicationSubmissionStopRecord({ schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage, ...stopAttempt(scope) })
  if (!attempt) return "fenced"
  const key = stopEventKey(attempt)
  const eventIds = APPLICATION_SUBMISSION_STOP_STAGES.map(value => applicationSubmissionStopEventId(key, value))
  const approvalStore = createPgApprovalStore(pool, { userId: attempt.userId })
  const fenced = await withExactSubmissionClientWrite(client, attempt, `submission_stop_protocol_${stage}`, async () => {
    const taskRows = await client.query<TaskRow>(`SELECT "status", "checkpoint", "workerTaskId" FROM application_tasks
      WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" = $4 AND "fillTurnId" = $5 FOR UPDATE`,
    [attempt.applicationTaskId, attempt.userId, attempt.jobId, attempt.sessionId, attempt.fillTurnId])
    const task = taskRows.rows[0]
    if (taskRows.rows.length !== 1 || task?.status !== "filling" || task.checkpoint !== "submission_request_started" || task.workerTaskId !== attempt.workerTaskId) return "fenced"

    const attempts = await client.query<AttemptRow>(`SELECT "artifactHash", "state" FROM "submission_attempt"
      WHERE "userId" = $1 AND "jobId" = $2 AND "receiptId" = $3 AND "constraintHash" = $4 FOR UPDATE`,
    [attempt.userId, attempt.jobId, attempt.receiptId, attempt.constraintHash])
    if (attempts.rows.length !== 1 || attempts.rows[0]?.state !== "reserved") return "fenced"

    const approval = await approvalStore.inspectSubmissionInTransaction(client, attempt.approvalId, attempt)
    if (!approval || approval.status !== "consumed" || !approval.consumedAt || approval.scope.resourceHash !== attempts.rows[0]?.artifactHash) return "fenced"

    const started = await client.query<StartEventRow>(`SELECT "taskId", "type", "actor", "data" FROM "application_task_events" WHERE "id" = $1`,
      [`evt_${attempt.executionId}`])
    if (started.rows.length !== 1 || !matchesStartedEvent(started.rows[0], attempt)) return "fenced"

    const rows = await client.query<StopEventRow>(`SELECT "id", "taskId", "type", "actor", "body", "data" FROM "application_task_events"
      WHERE "id" = ANY($1::text[]) ORDER BY "id" ASC`, [eventIds])
    if (rows.rows.length > eventIds.length) return "fenced"
    const stageById = new Map(eventIds.map((id, index) => [id, APPLICATION_SUBMISSION_STOP_STAGES[index]!]))
    const existing = new Map<ApplicationSubmissionStopStage, true>()
    for (const row of rows.rows) {
      const eventStage = stageById.get(row.id)
      const record = parseApplicationSubmissionStopRecord(row.data)
      const actor = eventStage === "stop_requested" ? "user" : "worker"
      if (!eventStage || row.taskId !== attempt.applicationTaskId || row.type !== EVENT_TYPE || row.actor !== actor || row.body !== EVENT_BODY
        || !record || record.stage !== eventStage || !matchesExactApplicationSubmissionStopAttempt(record, attempt) || existing.has(eventStage)) return "fenced"
      existing.set(eventStage, true)
    }
    const armed = existing.has("armed"), stopped = existing.has("stop_requested"), granted = existing.has("dispatch_granted")
    if (armed && stopped && !granted) return "stopped"
    if (stage === "armed" && armed && !stopped && !granted) return "duplicate"
    if (stage === "dispatch_granted" && armed && granted && !stopped) return "duplicate"
    if (stopped || granted || (stage === "dispatch_granted" && !armed) || (stage === "armed" && existing.size > 0)) return "fenced"

    const record = { ...attempt, schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage }
    const inserted = await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
      VALUES ($1, $2, $3, 'worker', $4, $5::jsonb, NOW()) RETURNING "id"`,
    [applicationSubmissionStopEventId(key, stage), attempt.applicationTaskId, EVENT_TYPE, EVENT_BODY, JSON.stringify(record)])
    return inserted.rowCount === 1 ? "recorded" : "fenced"
  })
  return fenced.kind === "current" ? fenced.value : "fenced"
}
