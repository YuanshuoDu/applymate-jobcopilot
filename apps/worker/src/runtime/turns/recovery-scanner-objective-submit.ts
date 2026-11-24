import type pg from "pg"
import type { ApplicationSubmissionExecution } from "../../queue/application-submit-fence.js"
import { readObjectiveApplicationSubmitSettlement, type ObjectiveApplicationSubmitSettlement } from "../../db/objective-application-submit-settlement.js"
import { hashArtifactContent } from "../subagents/artifact-adapters.js"
import type { AgentTurnWakeupPayload } from "../wakeup/types.js"
import { parseWakeup } from "../wakeup/types.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type ObjectiveSubmitRootWait = Readonly<{ kind: "parked_dependency"; waitId: string } | { kind: "explicit_approval"; waitId: string | null }>
type Receipt = Readonly<{ schemaVersion: typeof OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA; userId: string; sessionId: string;
  jobId: string; applicationTaskId: string; fillTurnId: string; approvalId: string; constraintHash: string; workerTaskId: string;
  executionId: string; attemptId: string; resultLinkEventId: string; applyResultId: number }>
export type ObjectiveApplicationSubmitFinalizationReceipt = Receipt & Readonly<{ eventId: string; eventCreatedAt: Date | string }>
export const OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA = "agent-harness.v2.objective-application-submit-finalization-queued.v1" as const
export const OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE = "objective_application_submit_finalization_queued" as const
export const OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY = "Objective submit finalization queued." as const
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const HASH = /^[a-f0-9]{64}$/
export type ObjectiveApplicationSubmitFinalizationReceiptData = Receipt

export function objectiveApplicationSubmitFinalizationEventId(
  execution: Pick<ApplicationSubmissionExecution, "applicationTaskId" | "fillTurnId" | "executionId">,
  resultLinkEventId: string,
): string {
  return `objective-application-submit-finalization:${hashArtifactContent([execution.applicationTaskId,
    execution.fillTurnId, execution.executionId, resultLinkEventId]).slice(7)}`
}

export function parseObjectiveApplicationSubmitFinalizationReceipt(value: unknown): Receipt | null {
  const row = exactRecord(value, ["schemaVersion", "userId", "sessionId", "jobId", "applicationTaskId", "fillTurnId",
    "approvalId", "constraintHash", "workerTaskId", "executionId", "attemptId", "resultLinkEventId", "applyResultId"])
  if (!row || row.schemaVersion !== OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA
    || ![row.userId, row.sessionId, row.jobId, row.applicationTaskId, row.fillTurnId, row.approvalId,
      row.workerTaskId, row.executionId, row.attemptId, row.resultLinkEventId].every(isId)
    || typeof row.constraintHash !== "string" || !HASH.test(row.constraintHash)
    || !Number.isSafeInteger(row.applyResultId) || Number(row.applyResultId) < 1) return null
  return Object.freeze({ schemaVersion: OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA, userId: row.userId as string,
    sessionId: row.sessionId as string, jobId: row.jobId as string, applicationTaskId: row.applicationTaskId as string,
    fillTurnId: row.fillTurnId as string, approvalId: row.approvalId as string, constraintHash: row.constraintHash,
    workerTaskId: row.workerTaskId as string, executionId: row.executionId as string, attemptId: row.attemptId as string,
    resultLinkEventId: row.resultLinkEventId as string, applyResultId: Number(row.applyResultId) })
}

/** Accepts only the two healthy Root projections produced by Objective approval. */
export function parseObjectiveSubmitRootWait(status: unknown, failureReason: unknown, value: unknown): ObjectiveSubmitRootWait | null {
  const row = exactRecord(value, ["status", "stepCount", "toolCallCount", "finalItemId", "waitId"])
  if (!row || !Number.isSafeInteger(row.stepCount) || Number(row.stepCount) < 0
    || !Number.isSafeInteger(row.toolCallCount) || Number(row.toolCallCount) < 0
    || (row.finalItemId !== null && !isId(row.finalItemId))) return null
  if (status === "waiting" && failureReason === null && row.status === "waiting_for_dependency" && isId(row.waitId)) {
    return { kind: "parked_dependency", waitId: row.waitId }
  }
  if (status === "waiting_for_user" && row.status === "waiting_for_approval") {
    if (failureReason === null && isId(row.waitId)) return { kind: "explicit_approval", waitId: row.waitId }
    if (failureReason === "policy_requires_approval" && row.waitId === null) return { kind: "explicit_approval", waitId: null }
  }
  return null
}

export function objectiveSubmitRootWaitMatchesApproval(rootWait: ObjectiveSubmitRootWait, approvalWaitId: string): boolean {
  return rootWait.kind !== "explicit_approval" || rootWait.waitId === null || rootWait.waitId === approvalWaitId
}

/** Binds a parked Root result to its exact owner-scoped durable wait and Step. */
export async function hasParkedObjectiveRootWaitWithClient(
  client: Client, scope: Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; waitId: string }>,
): Promise<boolean> {
  if (![scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.waitId].every(isId)) return false
  const found = await client.query<Row>(`SELECT wait."id",wait."status",wait."suspendedAt",wait."resolvedAt",wait."consumedAt",
      step."id" AS "stepId",step."taskId",step."attempt",step."status" AS "stepStatus"
    FROM "agent_wait_conditions" AS wait
    JOIN "agent_sessions" AS session ON session."id"=wait."sessionId" AND session."userId"=wait."userId"
    JOIN "agent_turns" AS turn ON turn."id"=wait."turnId" AND turn."sessionId"=wait."sessionId" AND turn."userId"=wait."userId"
    JOIN "sub_agent_tasks" AS root ON root."id"=wait."parentTaskId" AND root."sessionId"=wait."sessionId" AND root."turnId"=wait."turnId"
    JOIN "agent_steps" AS step ON step."id"=wait."stepId" AND step."turnId"=wait."turnId" AND step."sessionId"=wait."sessionId"
    WHERE wait."id"=$1 AND wait."userId"=$2 AND wait."sessionId"=$3 AND wait."turnId"=$4 AND wait."parentTaskId"=$5
      AND wait."status" IN ('waiting','ready') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
      AND ((wait."status"='waiting' AND wait."resolvedAt" IS NULL) OR (wait."status"='ready' AND wait."resolvedAt" IS NOT NULL))
      AND session."status" IN ('running','waiting_for_user') AND turn."rootTaskId"=$5
      AND root."rootTaskId"=$5 AND root."role"='orchestrator' AND root."taskType"='root' AND root."status"='waiting'
      AND step."status"='waiting_for_tool' AND step."attempt"=1 AND (step."taskId"=$5 OR step."taskId" IS NULL)
    LIMIT 2`, [scope.waitId, scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId])
  const row = found.rows[0]
  return found.rows.length === 1 && row?.id === scope.waitId && isId(row.stepId)
}

/** Revalidates the immutable queue receipt, exact standard dispatch row, and confirmed Stage 2 settlement. */
export async function readObjectiveApplicationSubmitFinalizationWithClient(
  client: Client, execution: ApplicationSubmissionExecution,
): Promise<ObjectiveApplicationSubmitFinalizationReceipt | null> {
  if (!validExecution(execution)) return null
  const settlement = await readObjectiveApplicationSubmitSettlement(client, execution)
  if (!settlement) return null
  const eventId = objectiveApplicationSubmitFinalizationEventId(execution, settlement.resultLinkEventId)
  const found = await client.query<Row>(`SELECT "id","taskId","type","actor","body","data","createdAt" FROM "application_task_events"
    WHERE "taskId"=$1 AND ("id"=$2 OR ("type"=$3 AND "data"->>'fillTurnId'=$4)) LIMIT 2`,
  [execution.applicationTaskId, eventId, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE, execution.fillTurnId])
  const row = found.rows[0], receipt = parseObjectiveApplicationSubmitFinalizationReceipt(row?.data)
  if (found.rows.length !== 1 || !row || row.id !== eventId || row.taskId !== execution.applicationTaskId
    || row.type !== OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE || row.actor !== "worker"
    || row.body !== OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY || !date(row.createdAt)
    || !receipt || !sameReceipt(receipt, execution, settlement)) return null
  const dispatch = await client.query<Row>(`SELECT "topic","aggregateId","idempotencyKey","payload" FROM "agent_outbox"
    WHERE "topic"='agent.turn.dispatch' AND "aggregateId"=$1 AND "idempotencyKey"=$2 LIMIT 2`,
  [execution.sessionId, `turn-dispatch:${execution.fillTurnId}`])
  const payload = exactRecord(dispatch.rows[0]?.payload, ["turnId", "sessionId", "ownerId"])
  if (dispatch.rows.length !== 1 || dispatch.rows[0]?.aggregateId !== execution.sessionId
    || dispatch.rows[0]?.topic !== "agent.turn.dispatch" || dispatch.rows[0]?.idempotencyKey !== `turn-dispatch:${execution.fillTurnId}`
    || payload?.turnId !== execution.fillTurnId || payload.sessionId !== execution.sessionId
    || !isId(payload.ownerId)) return null
  return { ...receipt, eventId, eventCreatedAt: row.createdAt as Date | string }
}

/** Detects malformed or duplicate finalization evidence so marked turns cannot fall back to a generic model path. */
export async function hasObjectiveApplicationSubmitFinalizationEvidenceWithClient(
  client: Client, scope: Pick<ApplicationSubmissionExecution, "applicationTaskId">,
): Promise<boolean> {
  const found = await client.query(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1
    AND ("type"=$2 OR "id" LIKE 'objective-application-submit-finalization:%') LIMIT 1`,
  [scope.applicationTaskId, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE])
  return found.rows.length > 0
}

/** The original approved wake must be fully consumed before the scanner advances its Turn revision. */
export async function hasPublishedObjectiveSubmitWakeWithClient(
  client: Client,
  wake: AgentTurnWakeupPayload,
  applicationTaskId: string,
): Promise<boolean> {
  const resolutions = await client.query<Row>(`SELECT "id","sessionId","turnId","itemId","taskId","type","actor","correlationId","idempotencyKey"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "itemId"=$3 AND "correlationId"=$4
      AND "type"='approval.resolved' AND "actor"='user' LIMIT 2`,
  [wake.sessionId, wake.turnId, wake.itemId, wake.waitId])
  const resolution = resolutions.rows[0]
  if (resolutions.rows.length !== 1 || !resolution || !isId(resolution.id) || resolution.sessionId !== wake.sessionId
    || resolution.turnId !== wake.turnId || resolution.itemId !== wake.itemId || resolution.taskId !== applicationTaskId
    || resolution.type !== "approval.resolved" || resolution.actor !== "user" || resolution.correlationId !== wake.waitId
    || typeof resolution.idempotencyKey !== "string" || !resolution.idempotencyKey.startsWith("agent-wait-command:")
    || resolution.idempotencyKey.length === "agent-wait-command:".length) return false
  const key = `${resolution.idempotencyKey}:wakeup`
  const found = await client.query<Row>(`SELECT "topic","aggregateId","idempotencyKey","payload","publishedAt","lastError"
    FROM "agent_outbox" WHERE "topic"='agent.turn.wakeup' AND "aggregateId"=$1 AND "idempotencyKey"=$2 LIMIT 2`,
  [wake.sessionId, `agent-event:${wake.eventId}`])
  const row = found.rows[0], envelope = exactRecord(row?.payload,
    ["eventId", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"])
  const delivered = envelope ? parseWakeup(envelope) : null
  return found.rows.length === 1 && !!row && row.topic === "agent.turn.wakeup" && row.aggregateId === wake.sessionId
    && row.idempotencyKey === `agent-event:${wake.eventId}` && date(row.publishedAt) !== null && row.lastError === null
    && !!envelope && delivered?.eventId === wake.eventId && delivered.sessionId === wake.sessionId
    && delivered.turnId === wake.turnId && delivered.itemId === wake.itemId && delivered.waitKind === wake.waitKind
    && delivered.waitId === wake.waitId && delivered.toolCallId === wake.toolCallId && delivered.status === wake.status
    && delivered.nextTurnRevision === wake.nextTurnRevision && envelope.taskId === null && envelope.type === "turn.wakeup"
    && envelope.actor === "user" && envelope.correlationId === wake.turnId && envelope.causationId === resolution.id
    && envelope.idempotencyKey === key && typeof envelope.sequence === "string" && /^[1-9][0-9]*$/.test(envelope.sequence)
}

/** Builds only the exact bounded receipt for one linked, settled attempt. */
export function objectiveApplicationSubmitFinalizationReceiptFor(
  execution: ApplicationSubmissionExecution, settlement: ObjectiveApplicationSubmitSettlement,
): ObjectiveApplicationSubmitFinalizationReceiptData {
  return Object.freeze({ schemaVersion: OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_SCHEMA, userId: execution.userId,
    sessionId: execution.sessionId, jobId: execution.jobId, applicationTaskId: execution.applicationTaskId,
    fillTurnId: execution.fillTurnId, approvalId: execution.approvalId, constraintHash: execution.constraintHash,
    workerTaskId: execution.workerTaskId, executionId: execution.executionId, attemptId: settlement.attemptId,
    resultLinkEventId: settlement.resultLinkEventId, applyResultId: settlement.applyResultId })
}

function sameReceipt(receipt: Receipt, execution: ApplicationSubmissionExecution, settlement: ObjectiveApplicationSubmitSettlement): boolean {
  return receipt.userId === execution.userId && receipt.sessionId === execution.sessionId && receipt.jobId === execution.jobId
    && receipt.applicationTaskId === execution.applicationTaskId && receipt.fillTurnId === execution.fillTurnId
    && receipt.approvalId === execution.approvalId && receipt.constraintHash === execution.constraintHash
    && receipt.workerTaskId === execution.workerTaskId && receipt.executionId === execution.executionId
    && receipt.attemptId === settlement.attemptId && receipt.resultLinkEventId === settlement.resultLinkEventId
    && receipt.applyResultId === settlement.applyResultId
}

function validExecution(value: ApplicationSubmissionExecution): boolean {
  return [value.applicationTaskId, value.userId, value.jobId, value.sessionId, value.fillTurnId, value.approvalId,
    value.workerTaskId, value.executionId].every(isId) && HASH.test(value.constraintHash)
}
function isId(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
function date(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  const parsed = record(value)
  if (!parsed) return null
  try {
    const own = Reflect.ownKeys(parsed)
    if ((Object.getPrototypeOf(parsed) !== Object.prototype && Object.getPrototypeOf(parsed) !== null)
      || own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return null
    if (!own.every(key => { const descriptor = Object.getOwnPropertyDescriptor(parsed, key); return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value") })) return null
    return parsed
  } catch { return null }
}
