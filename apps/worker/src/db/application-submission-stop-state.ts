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
export type WorkerSubmissionStopInspection = "missing" | "armed" | "stopped" | "granted" | "fenced"

type TaskRow = {
  status: string; checkpoint: string | null; workerTaskId: string | null; completedAt: Date | null
  fillTurnSessionId: string | null; fillTurnUserId: string | null
}
type AttemptRow = { artifactHash: string; state: string; responseRef: string | null }
type StartEventRow = { taskId: string; type: string; actor: string; data: unknown }
type StopEventRow = { id: string; taskId: string; type: string; actor: string; body: string; data: unknown }
type ExistingStopState =
  | { readonly kind: "current"; readonly stages: Set<ApplicationSubmissionStopStage>; readonly task: TaskRow; readonly attempt: AttemptRow }
  | { readonly kind: "superseded" }

export type StoppedSubmissionFinalizationProof =
  | { readonly kind: "ready"; readonly attemptState: "reserved" | "failed"; readonly artifactHash: string }
  | { readonly kind: "already_finalized" }
  | { readonly kind: "superseded" }
  | { readonly kind: "unavailable" }

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
  const fenced = await withExactSubmissionClientWrite(client, attempt, `submission_stop_protocol_${stage}`, async () => {
    const existing = await readExistingStages(pool, client, attempt)
    if (!existing || existing.kind !== "current") return "fenced"
    const state = classifyStages(existing.stages)
    if (state === "stopped") return "stopped"
    if (stage === "armed" && state === "armed" || stage === "dispatch_granted" && state === "granted") return "duplicate"
    if (stage === "armed" ? state !== "missing" : state !== "armed") return "fenced"

    const record = { ...attempt, schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage }
    const inserted = await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
      VALUES ($1, $2, $3, 'worker', $4, $5::jsonb, NOW()) RETURNING "id"`,
    [applicationSubmissionStopEventId(key, stage), attempt.applicationTaskId, EVENT_TYPE, EVENT_BODY, JSON.stringify(record)])
    return inserted.rowCount === 1 ? "recorded" : "fenced"
  })
  return fenced.kind === "current" ? fenced.value : "fenced"
}

/** Reads the exact attempt's stage set; callers must hold their source and owner fences. */
export async function inspectApplicationSubmissionStopState(
  pool: Pool, client: PoolClient, scope: ApplicationSubmissionStartScope,
): Promise<WorkerSubmissionStopInspection> {
  if (scope.turnId !== scope.fillTurnId) return "fenced"
  const attempt = parseApplicationSubmissionStopRecord({ schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
    stage: "armed", ...stopAttempt(scope) })
  if (!attempt) return "fenced"
  const fenced = await withExactSubmissionClientWrite(client, attempt, "inspect_submission_stop_protocol", async () => {
    const existing = await readExistingStages(pool, client, attempt)
    return existing?.kind === "current" ? classifyStages(existing.stages) : "fenced"
  })
  return fenced.kind === "current" ? fenced.value : "fenced"
}

/** Reads the exact stop proof for post-tool terminalization inside its owner's transaction. */
export async function readStoppedSubmissionFinalizationProof(
  pool: Pool, client: PoolClient, scope: ApplicationSubmissionStartScope,
): Promise<StoppedSubmissionFinalizationProof> {
  if (scope.turnId !== scope.fillTurnId) return { kind: "unavailable" }
  const attempt = parseApplicationSubmissionStopRecord({ schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
    stage: "armed", ...stopAttempt(scope) })
  if (!attempt) return { kind: "unavailable" }
  const existing = await readExistingStages(pool, client, attempt, "finalization")
  if (!existing) return { kind: "unavailable" }
  if (existing.kind === "superseded") return { kind: "superseded" }
  if (classifyStages(existing.stages) !== "stopped") return { kind: "unavailable" }
  if (existing.task.status === "failed") return { kind: "already_finalized" }
  return { kind: "ready", attemptState: existing.attempt.state as "reserved" | "failed", artifactHash: existing.attempt.artifactHash }
}

async function readExistingStages(
  pool: Pool, client: PoolClient, attempt: ApplicationSubmissionStopAttempt,
  mode: "strict" | "finalization" = "strict",
): Promise<ExistingStopState | null> {
  const taskRows = await client.query<TaskRow>(`SELECT "status", "checkpoint", "workerTaskId", "completedAt", "fillTurnSessionId", "fillTurnUserId" FROM application_tasks
    WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3 AND "sessionId" = $4 AND "fillTurnId" = $5 FOR UPDATE`,
  [attempt.applicationTaskId, attempt.userId, attempt.jobId, attempt.sessionId, attempt.fillTurnId])
  const task = taskRows.rows[0]
  if (taskRows.rows.length !== 1 || !task) return null
  if (mode === "finalization" && typeof task.workerTaskId === "string" && task.workerTaskId.trim()
    && task.workerTaskId !== attempt.workerTaskId) return { kind: "superseded" }
  if (task.workerTaskId !== attempt.workerTaskId) return null
  const liveTask = task.status === "filling" && task.checkpoint === "submission_request_started" && task.completedAt === null
  const validCompletedAt = task.completedAt instanceof Date && !Number.isNaN(task.completedAt.getTime())
  const stoppedTask = task.status === "failed" && task.checkpoint === "turn_stopped_before_submit" && validCompletedAt
  if (mode === "strict") {
    if (task.status !== "filling" || task.checkpoint !== "submission_request_started") return null
  } else if (!task.fillTurnSessionId || task.fillTurnSessionId !== attempt.sessionId || task.fillTurnUserId !== attempt.userId
    || (!liveTask && !stoppedTask)) return null
  const attempts = await client.query<AttemptRow>(`SELECT "artifactHash", "state", "responseRef" FROM "submission_attempt"
    WHERE "userId" = $1 AND "jobId" = $2 AND "receiptId" = $3 AND "constraintHash" = $4 FOR UPDATE`,
  [attempt.userId, attempt.jobId, attempt.receiptId, attempt.constraintHash])
  const submissionAttempt = attempts.rows[0]
  if (attempts.rows.length !== 1 || !submissionAttempt
    || (mode === "strict" ? submissionAttempt.state !== "reserved"
      : submissionAttempt.responseRef !== null || !["reserved", "failed"].includes(submissionAttempt.state))
    || (stoppedTask && submissionAttempt.state !== "failed")) return null
  const approval = await createPgApprovalStore(pool, { userId: attempt.userId })
    .inspectSubmissionInTransaction(client, attempt.approvalId, attempt)
  if (!approval || approval.status !== "consumed" || !approval.consumedAt || approval.scope.resourceHash !== submissionAttempt.artifactHash) return null
  const started = await client.query<StartEventRow>(`SELECT "taskId", "type", "actor", "data" FROM "application_task_events" WHERE "id" = $1`,
    [`evt_${attempt.executionId}`])
  if (started.rows.length !== 1 || !matchesStartedEvent(started.rows[0], attempt)) return null
  const key = stopEventKey(attempt)
  const eventIds = APPLICATION_SUBMISSION_STOP_STAGES.map(stage => applicationSubmissionStopEventId(key, stage))
  const rows = await client.query<StopEventRow>(`SELECT "id", "taskId", "type", "actor", "body", "data" FROM "application_task_events"
    WHERE "id" = ANY($1::text[]) ORDER BY "id" ASC`, [eventIds])
  if (rows.rows.length > eventIds.length) return null
  const stageById = new Map(eventIds.map((id, index) => [id, APPLICATION_SUBMISSION_STOP_STAGES[index]!]))
  const existing = new Set<ApplicationSubmissionStopStage>()
  for (const row of rows.rows) {
    const stage = stageById.get(row.id), record = parseApplicationSubmissionStopRecord(row.data)
    const actor = stage === "stop_requested" ? "user" : "worker"
    if (!stage || row.taskId !== attempt.applicationTaskId || row.type !== EVENT_TYPE || row.actor !== actor || row.body !== EVENT_BODY
      || !record || record.stage !== stage || !matchesExactApplicationSubmissionStopAttempt(record, attempt) || existing.has(stage)) return null
    existing.add(stage)
  }
  if (mode === "finalization") {
    const evidence = await client.query(`SELECT "id" FROM "application_task_events"
      WHERE "taskId" = $1 AND "type" = 'submission_evidence_recorded'
        AND ("data"->>'approvalId' = $2 OR "data"->>'workerTaskId' = $3 OR "data"->>'executionId' = $4) LIMIT 1`,
    [attempt.applicationTaskId, attempt.approvalId, attempt.workerTaskId, attempt.executionId])
    if (evidence.rows.length !== 0) return null
  }
  return { kind: "current", stages: existing, task, attempt: submissionAttempt }
}

function classifyStages(stages: ReadonlySet<ApplicationSubmissionStopStage>): WorkerSubmissionStopInspection {
  const armed = stages.has("armed"), stopped = stages.has("stop_requested"), granted = stages.has("dispatch_granted")
  if (!stages.size) return "missing"
  if (armed && stopped && !granted) return "stopped"
  if (armed && granted && !stopped) return "granted"
  if (armed && !stopped && !granted) return "armed"
  return "fenced"
}
