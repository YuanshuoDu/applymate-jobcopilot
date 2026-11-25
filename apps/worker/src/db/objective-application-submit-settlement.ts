import { parseObjectiveReviewedFillSource } from "@jobcopilot/shared"
import type { PoolClient } from "pg"
import type { ApplicationSubmissionExecution } from "../queue/application-submit-fence.js"
import {
  OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA, objectiveApplicationSubmitResultEventId,
  readObjectiveApplicationSubmitResultWithClient,
} from "./objective-application-submit-result.js"

type Client = Pick<PoolClient, "query">
type TaskRow = {
  id: string; userId: string; sessionId: string; jobId: string; fillTurnId: string; fillTurnSessionId: string
  fillTurnUserId: string; workerTaskId: string | null; status: string; checkpoint: string | null; completedAt: Date | string | null
}
type TurnRow = { id: string; status: string; executionMode: string | null; input: unknown }
type FillTurnStatus = "waiting_for_approval" | "queued" | "in_progress" | "completed"
type ExecutionEvent = { id: string; type: string; actor: string; body: string; data: unknown; createdAt: Date | string }
type JobRow = { id: string; userId: string; status: string; workflowState: string; appliedAt: Date | string | null }

/** Read-only exact proof for a settled Objective submit; caller holds the application fence transaction. */
export type ObjectiveApplicationSubmitSettlement = Readonly<{
  userId: string; sessionId: string; applicationTaskId: string; jobId: string; fillTurnId: string
  approvalId: string; workerTaskId: string; executionId: string; attemptId: string
  resultLinkEventId: string; applyResultId: number; fillTurnStatus: FillTurnStatus
}>

/** Returns only bounded identifiers after the exact browser submit, task, approval, Job, and result link agree. */
export async function readObjectiveApplicationSubmitSettlement(
  client: Client, scope: ApplicationSubmissionExecution,
): Promise<ObjectiveApplicationSubmitSettlement | null> {
  const execution = projectExecution(scope)
  if (!execution) return null
  const [tasks, turns, events, jobs] = await Promise.all([
    client.query<TaskRow>(`SELECT "id","userId","sessionId","jobId","fillTurnId","fillTurnSessionId","fillTurnUserId","workerTaskId","status","checkpoint","completedAt"
      FROM "application_tasks" WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5
        AND "fillTurnSessionId"=$4 AND "fillTurnUserId"=$2 LIMIT 2`,
    [scope.applicationTaskId, scope.userId, scope.jobId, scope.sessionId, scope.fillTurnId]),
    client.query<TurnRow>(`SELECT "id","status","executionMode","input" FROM "agent_turns"
      WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 LIMIT 2`, [scope.fillTurnId, scope.sessionId, scope.userId]),
    client.query<ExecutionEvent>(`SELECT "id","type","actor","body","data","createdAt" FROM "application_task_events"
      WHERE "taskId"=$1 AND "type" IN ('submission_execution_started','submission_execution_settled')
        AND ("data"->>'approvalId'=$2 OR "data"->>'workerTaskId'=$3 OR "data"->>'executionId'=$4 OR "id"=$5)
      ORDER BY "createdAt" ASC,"id" ASC LIMIT 4`,
    [execution.applicationTaskId, execution.approvalId, execution.workerTaskId, execution.executionId, `evt_${execution.executionId}`]),
    client.query<JobRow>(`SELECT "id","userId","status","workflowState","appliedAt" FROM "Job"
      WHERE "id"=$1 AND "userId"=$2 LIMIT 2`, [scope.jobId, scope.userId]),
  ])
  const task = one(tasks.rows), turn = one(turns.rows), job = one(jobs.rows)
  if (!task || !turn || !job || events.rows.length !== 2) return null
  if (task.workerTaskId !== scope.workerTaskId || task.status !== "submitted" || task.checkpoint !== "submission_verified"
    || !date(task.completedAt) || !isFillTurnStatus(turn.status) || turn.executionMode !== "canonical_task_graph"
    || !parseObjectiveReviewedFillSource(turn.input)) return null
  if (!validJob(job, scope)) return null
  const startedRows = events.rows.filter(event => event.type === "submission_execution_started")
  const settledRows = events.rows.filter(event => event.type === "submission_execution_settled")
  const started = startedRows[0], settled = settledRows[0]
  const startedAt = started ? date(started.createdAt) : null
  const settledAt = settled ? date(settled.createdAt) : null
  if (events.rows.length !== 2 || startedRows.length !== 1 || settledRows.length !== 1 || !started || !settled
    || !exactExecutionEvent(started, "submission_execution_started", scope)
    || !exactExecutionEvent(settled, "submission_execution_settled", scope)
    || started.id !== `evt_${scope.executionId}` || started.id === settled.id
    || !startedAt || !settledAt || startedAt > settledAt) return null
  const linked = await readObjectiveApplicationSubmitResultWithClient(client, execution)
  const linkedAt = linked ? date(linked.eventCreatedAt) : null
  if (!linked || linked.schemaVersion !== OBJECTIVE_APPLICATION_SUBMIT_RESULT_SCHEMA
    || linked.eventId !== objectiveApplicationSubmitResultEventId(execution) || !sameReceiptScope(linked, execution)
    || !linkedAt || linked.eventId === started.id || linked.eventId === settled.id
    || startedAt > linkedAt || linkedAt > settledAt
    || !id(linked.eventId) || !id(linked.attemptId)
    || !Number.isSafeInteger(linked.applyResultId) || linked.applyResultId < 1) return null
  return { userId: scope.userId, sessionId: scope.sessionId, applicationTaskId: scope.applicationTaskId,
    jobId: scope.jobId, fillTurnId: scope.fillTurnId, approvalId: scope.approvalId,
    workerTaskId: scope.workerTaskId, executionId: scope.executionId, attemptId: linked.attemptId,
    resultLinkEventId: linked.eventId, applyResultId: linked.applyResultId, fillTurnStatus: turn.status }
}

function isFillTurnStatus(value: string): value is FillTurnStatus {
  return value === "waiting_for_approval" || value === "queued" || value === "in_progress" || value === "completed"
}

function validJob(row: JobRow, scope: ApplicationSubmissionExecution): boolean {
  return row.id === scope.jobId && row.userId === scope.userId && row.status === "applied"
    && row.workflowState === "submitted" && date(row.appliedAt) !== null
}
function exactExecutionEvent(event: ExecutionEvent, type: string, scope: ApplicationSubmissionExecution): boolean {
  const data = record(event.data)
  return event.type === type && event.actor === "worker"
    && event.body === (type === "submission_execution_started" ? "Submit execution started" : "Submit execution settled")
    && Boolean(data && Object.keys(data).sort().join(",") === "applicationTaskId,approvalId,constraintHash,executionId,fillTurnId,jobId,sessionId,userId,workerTaskId"
      && data.applicationTaskId === scope.applicationTaskId && data.approvalId === scope.approvalId
      && data.constraintHash === scope.constraintHash && data.executionId === scope.executionId
      && data.fillTurnId === scope.fillTurnId && data.jobId === scope.jobId
      && data.sessionId === scope.sessionId && data.userId === scope.userId && data.workerTaskId === scope.workerTaskId)
    && id(event.id) && date(event.createdAt) !== null
}
function projectExecution(value: unknown): ApplicationSubmissionExecution | null {
  const data = record(value)
  if (!data || ![data.sessionId, data.fillTurnId, data.applicationTaskId, data.userId, data.jobId,
    data.approvalId, data.workerTaskId, data.executionId].every(id) || !hash(data.constraintHash)) return null
  return { sessionId: data.sessionId as string, fillTurnId: data.fillTurnId as string,
    applicationTaskId: data.applicationTaskId as string, userId: data.userId as string,
    jobId: data.jobId as string, approvalId: data.approvalId as string, workerTaskId: data.workerTaskId as string,
    executionId: data.executionId as string, constraintHash: data.constraintHash }
}
function sameReceiptScope(receipt: {
  applicationTaskId: string; userId: string; jobId: string; sessionId: string; fillTurnId: string; approvalId: string
  constraintHash: string; workerTaskId: string; executionId: string
}, scope: ApplicationSubmissionExecution): boolean {
  return receipt.applicationTaskId === scope.applicationTaskId && receipt.userId === scope.userId && receipt.jobId === scope.jobId
    && receipt.sessionId === scope.sessionId && receipt.fillTurnId === scope.fillTurnId && receipt.approvalId === scope.approvalId
    && receipt.constraintHash === scope.constraintHash && receipt.workerTaskId === scope.workerTaskId && receipt.executionId === scope.executionId
}
function one<T>(rows: readonly T[]): T | null { return rows.length === 1 ? rows[0] ?? null : null }
function record(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Object.values(descriptors).every(descriptor => "value" in descriptor) ? value as Record<string, unknown> : null
  } catch { return null }
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function date(value: Date | string | null): Date | null {
  if (value === null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}
