import { randomUUID } from "node:crypto"
import type pg from "pg"
import { OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, parseObjectiveReviewedFillSource } from "@jobcopilot/shared"

import { getPool } from "../../db/apply-results.js"
import { readObjectiveApplicationSubmitSettlement } from "../../db/objective-application-submit-settlement.js"
import type { ApplicationSubmissionExecution } from "../../queue/application-submit-fence.js"
import { inspectObjectiveFinalSubmitWake } from "../wakeup/resume-objective-final-submit-wait.js"
import { parseWakeup } from "../wakeup/types.js"
import type { LeasePool } from "./lease.js"
import {
  hasObjectiveApplicationSubmitFinalizationEvidenceWithClient,
  objectiveApplicationSubmitFinalizationEventId,
  objectiveApplicationSubmitFinalizationReceiptFor,
  hasParkedObjectiveRootWaitWithClient,
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE,
  hasPublishedObjectiveSubmitWakeWithClient,
  objectiveSubmitRootWaitMatchesApproval,
  parseObjectiveSubmitRootWait,
} from "./recovery-scanner-objective-submit.js"
import { TURN_DISPATCH_MAX_BATCH, type TurnDispatchQueue, withTransaction } from "./recovery-scanner-common.js"
import { ensureQueuedTurnDispatches } from "./recovery-scanner-queue-repair.js"
import { dispatchPendingTurnOutbox } from "./recovery-scanner-delivery.js"
import { reconcilePendingSessionControls } from "../session-control/pause-recovery.js"
import {
  persistTurnDispatch,
  persistWakeupTurnDispatchInTransaction,
  reclaimExpiredTurns,
  repairLegacyTurnDispatchAggregates,
} from "./recovery-scanner-storage.js"

export { TURN_DISPATCH_TOPIC, TURN_DISPATCH_MAX_BATCH, turnDispatchKey, turnJobId } from "./recovery-scanner-common.js"
export type { TurnDispatchQueue } from "./recovery-scanner-common.js"
export { dispatchPendingTurnOutbox } from "./recovery-scanner-delivery.js"
export {
  persistTurnDispatch,
  persistTurnDispatchInTransaction,
  persistWakeupTurnDispatchInTransaction,
  reclaimExpiredTurns,
  repairLegacyTurnDispatchAggregates,
} from "./recovery-scanner-storage.js"

export const TURN_DISPATCH_POLL_MS = 30_000

export type RecoveryReport = { reclaimed: number; repaired: number; dispatched: number }

type Row = Record<string, unknown>
type ObjectiveCandidate = { userId: string; sessionId: string; turnId: string; rootTaskId: string; updatedAt: Date | string }
type CandidateCursor = { updatedAt: string; turnId: string }
let objectiveCursor: CandidateCursor | null = null

export async function recoverTurnQueue(
  pool: LeasePool,
  queue: TurnDispatchQueue,
  ownerId = `recovery-${randomUUID()}`,
  now = new Date(),
): Promise<RecoveryReport> {
  await reconcilePendingSessionControls(pool).catch((error: unknown) => {
    console.error("[turn-recovery] session control scan failed:", error)
  })
  const legacyRepaired = await repairLegacyTurnDispatchAggregates(pool, TURN_DISPATCH_MAX_BATCH)
  const reclaimed = await reclaimExpiredTurns(pool, now, TURN_DISPATCH_MAX_BATCH)
  for (const turn of reclaimed) {
    await persistTurnDispatch(pool, { turnId: turn.turnId, sessionId: turn.sessionId, ownerId }, true)
  }
  const objectiveQueued = await recoverObjectiveSubmitFinalizations(pool, TURN_DISPATCH_MAX_BATCH, now)
  const repaired = legacyRepaired + objectiveQueued + await ensureQueuedTurnDispatches(pool, queue, ownerId, TURN_DISPATCH_MAX_BATCH)
  const dispatched = await dispatchPendingTurnOutbox(pool, queue)
  return { reclaimed: reclaimed.length, repaired, dispatched }
}

async function recoverObjectiveSubmitFinalizations(pool: LeasePool, limit: number, now: Date): Promise<number> {
  let candidates: ObjectiveCandidate[]
  try {
    candidates = await readObjectiveCandidates(pool, limit)
    if (!candidates.length && objectiveCursor) { objectiveCursor = null; candidates = await readObjectiveCandidates(pool, limit) }
  } catch {
    console.error("[turn-recovery] objective submit discovery failed")
    return 0
  }
  let queued = 0
  for (const candidate of candidates) {
    try { if (await queueObjectiveCandidate(pool, candidate, now)) queued += 1 }
    catch { console.error("[turn-recovery] objective submit candidate failed") }
  }
  return queued
}

async function readObjectiveCandidates(pool: LeasePool, limit: number): Promise<ObjectiveCandidate[]> {
  const result = await withTransaction(pool, async client => client.query<ObjectiveCandidate>(`SELECT turn."userId",turn."sessionId",turn."id" AS "turnId",
      turn."rootTaskId",turn."updatedAt" FROM "agent_sessions" AS session
    JOIN "agent_turns" AS turn ON turn."sessionId"=session."id" AND turn."userId"=session."userId"
    JOIN "sub_agent_tasks" AS root ON root."id"=turn."rootTaskId" AND root."sessionId"=turn."sessionId" AND root."turnId"=turn."id"
    WHERE session."status" IN ('running','waiting_for_user') AND turn."status"='waiting_for_approval'
      AND turn."source"='user' AND turn."executionMode"='canonical_task_graph' AND turn."leaseOwnerId" IS NULL AND turn."leaseExpiresAt" IS NULL
      AND turn."input"->'reviewedApplicationMaterialSource'->>'schemaVersion'=$1
      AND root."role"='orchestrator' AND root."taskType"='root' AND root."status" IN ('waiting','waiting_for_user')
      AND root."attemptCount"=1 AND root."leaseOwner" IS NULL AND root."leaseExpiresAt" IS NULL AND root."interruptRequestedAt" IS NULL AND root."closedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "agent_events" AS pause WHERE pause."sessionId"=session."id" AND pause."type"='session.pause_requested'
        AND NOT EXISTS (SELECT 1 FROM "agent_events" AS resumed WHERE resumed."sessionId"=pause."sessionId" AND resumed."turnId"=pause."turnId"
          AND resumed."type"='session.resume_requested' AND resumed."sequence">pause."sequence"))
      AND NOT EXISTS (SELECT 1 FROM "agent_turns" AS sibling WHERE sibling."sessionId"=session."id" AND sibling."userId"=session."userId"
        AND sibling."id"<>turn."id" AND sibling."status" IN ('queued','in_progress','waiting_for_dependency','waiting_for_approval','waiting_for_user'))
      AND EXISTS (SELECT 1 FROM "application_tasks" AS task JOIN "Job" AS job ON job."id"=task."jobId" AND job."userId"=task."userId"
        WHERE task."userId"=turn."userId" AND task."sessionId"=turn."sessionId" AND task."fillTurnId"=turn."id"
          AND task."fillTurnSessionId"=turn."sessionId" AND task."fillTurnUserId"=turn."userId"
          AND task."status"='submitted' AND task."checkpoint"='submission_verified' AND task."completedAt" IS NOT NULL
          AND job."status"='applied' AND job."workflowState"='submitted' AND job."appliedAt" IS NOT NULL)
      AND ($2::timestamptz IS NULL OR (turn."updatedAt",turn."id")>($2::timestamptz,$3::text))
    ORDER BY turn."updatedAt" ASC,turn."id" ASC LIMIT $4`,
  [OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, objectiveCursor?.updatedAt ?? null, objectiveCursor?.turnId ?? null, limit]))
  const rows = result.rows, last = rows[rows.length - 1], at = last ? date(last.updatedAt) : null
  if (last && at) objectiveCursor = { updatedAt: at.toISOString(), turnId: last.turnId }
  else if (last) objectiveCursor = null
  return rows
}

async function queueObjectiveCandidate(pool: LeasePool, candidate: ObjectiveCandidate, now: Date): Promise<boolean> {
  return withTransaction(pool, async client => {
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", candidate.userId])
    const session = await client.query<Row>(`SELECT "id","status" FROM "agent_sessions" WHERE "id"=$1 AND "userId"=$2
      AND "status" IN ('running','waiting_for_user') FOR UPDATE SKIP LOCKED`, [candidate.sessionId, candidate.userId])
    if (!session.rows[0] || await hasOpenSessionPause(client, candidate.sessionId)) return false
    const turns = await client.query<Row>(`SELECT "id","rootTaskId","source","executionMode","input","status","revision","leaseOwnerId","leaseExpiresAt","leaseStartedAt"
      FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 FOR UPDATE`, [candidate.turnId, candidate.sessionId, candidate.userId])
    const turn = turns.rows[0]
    if (turns.rows.length !== 1 || !turn || turn.rootTaskId !== candidate.rootTaskId || turn.status !== "waiting_for_approval"
      || turn.source !== "user" || turn.executionMode !== "canonical_task_graph" || !Number.isSafeInteger(turn.revision)
      || turn.leaseOwnerId !== null || turn.leaseExpiresAt !== null || turn.leaseStartedAt !== null
      || !parseObjectiveReviewedFillSource(turn.input)) return false
    const siblings = await client.query(`SELECT "id" FROM "agent_turns" WHERE "sessionId"=$1 AND "userId"=$2 AND "id"<>$3
      AND "status" IN ('queued','in_progress','waiting_for_dependency','waiting_for_approval','waiting_for_user') LIMIT 1`,
    [candidate.sessionId, candidate.userId, candidate.turnId])
    if (siblings.rows.length) return false
    const roots = await client.query<Row>(`SELECT "id","status","attemptCount","result","failureReason","leaseOwner","leaseExpiresAt","interruptRequestedAt","closedAt"
      FROM "sub_agent_tasks" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "rootTaskId"=$1 AND "role"='orchestrator'
        AND "taskType"='root' AND "parentTaskId" IS NULL FOR UPDATE`, [candidate.rootTaskId, candidate.sessionId, candidate.turnId])
    const root = roots.rows[0]
    const rootWait = parseObjectiveSubmitRootWait(root?.status, root?.failureReason, root?.result)
    if (roots.rows.length !== 1 || !root || !rootWait || Number(root.attemptCount) !== 1
      || root.leaseOwner !== null || root.leaseExpiresAt !== null || root.interruptRequestedAt !== null || root.closedAt !== null) return false
    const fillers = await client.query<Row>(`SELECT "id","status","leaseOwner","leaseExpiresAt","interruptRequestedAt" FROM "sub_agent_tasks"
      WHERE "sessionId"=$1 AND "turnId"=$2 AND "rootTaskId"=$3 AND "parentTaskId"=$3 AND "role"='application_filler'
        AND "taskType"='application_fill_for_review' FOR UPDATE`, [candidate.sessionId, candidate.turnId, candidate.rootTaskId])
    if (fillers.rows.length !== 1 || fillers.rows[0]?.status !== "completed" || fillers.rows[0]?.leaseOwner !== null
      || fillers.rows[0]?.leaseExpiresAt !== null || fillers.rows[0]?.interruptRequestedAt !== null) return false
    const tasks = await client.query<Row>(`SELECT "id","userId","sessionId","jobId","fillTurnId","fillTurnSessionId","fillTurnUserId","workerTaskId","status","checkpoint","completedAt"
      FROM "application_tasks" WHERE "userId"=$1 AND "sessionId"=$2 AND "fillTurnId"=$3 AND "fillTurnSessionId"=$2 AND "fillTurnUserId"=$1 FOR UPDATE`,
    [candidate.userId, candidate.sessionId, candidate.turnId])
    const task = tasks.rows[0]
    if (tasks.rows.length !== 1 || !task || task.status !== "submitted" || task.checkpoint !== "submission_verified"
      || !date(task.completedAt) || !isId(task.id) || !isId(task.jobId) || !isId(task.workerTaskId)) return false
    const jobs = await client.query<Row>(`SELECT "id","userId","status","workflowState","appliedAt" FROM "Job" WHERE "id"=$1 AND "userId"=$2 FOR UPDATE`, [task.jobId, candidate.userId])
    if (jobs.rows.length !== 1 || jobs.rows[0]?.status !== "applied" || jobs.rows[0]?.workflowState !== "submitted" || !date(jobs.rows[0]?.appliedAt)) return false
    const execution = await settledExecution(client, candidate, task)
    if (!execution) return false
    const wakeRows = await client.query<Row>(`SELECT "id" AS "eventId","sessionId","turnId","itemId","type","payload" FROM "agent_events"
      WHERE "sessionId"=$1 AND "turnId"=$2 AND "itemId"=$3 AND "type"='turn.wakeup' AND "payload"->>'toolCallId'=$4
        AND "payload"->>'status'='approved' LIMIT 2`, [candidate.sessionId, candidate.turnId,
      `agent-wait:approval:${execution.approvalId}`, `application-submit:${task.id}`])
    const wake = wakeRows.rows.length === 1 ? parseWakeup(wakeRows.rows[0]) : null
    if (!wake || wake.nextTurnRevision !== Number(turn.revision)
      || await inspectObjectiveFinalSubmitWake(client, wake, { source: String(turn.source), executionMode: turn.executionMode as string | null,
        input: turn.input, status: String(turn.status), revision: Number(turn.revision) }, candidate.userId) !== "acknowledge"
      || !await hasPublishedObjectiveSubmitWakeWithClient(client, wake, String(task.id))) return false
    if (!objectiveSubmitRootWaitMatchesApproval(rootWait, wake.waitId)) return false
    if (rootWait.kind === "parked_dependency" && !await hasParkedObjectiveRootWaitWithClient(client, {
      userId: candidate.userId, sessionId: candidate.sessionId, turnId: candidate.turnId, rootTaskId: candidate.rootTaskId,
      waitId: rootWait.waitId,
    })) return false
    const settlement = await readObjectiveApplicationSubmitSettlement(client, execution)
    if (!settlement || settlement.fillTurnStatus !== "waiting_for_approval") return false
    const eventId = objectiveApplicationSubmitFinalizationEventId(execution, settlement.resultLinkEventId)
    if (await hasObjectiveApplicationSubmitFinalizationEvidenceWithClient(client, execution)) return false
    const receipt = objectiveApplicationSubmitFinalizationReceiptFor(execution, settlement)
    const inserted = await client.query(`INSERT INTO "application_task_events" ("id","taskId","type","actor","body","data","createdAt")
      VALUES ($1,$2,$3,'worker',$4,$5::jsonb,$6) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
    [eventId, task.id, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_TYPE, OBJECTIVE_APPLICATION_SUBMIT_FINALIZATION_EVENT_BODY, JSON.stringify(receipt), now])
    if (inserted.rowCount !== 1) throw new Error("objective_submit_finalization_event_conflict")
    if (session.rows[0]?.status === "waiting_for_user") {
      const resumed = await client.query(`UPDATE "agent_sessions" SET "status"='running',"updatedAt"=$1 WHERE "id"=$2 AND "userId"=$3 AND "status"='waiting_for_user'`,
      [now, candidate.sessionId, candidate.userId])
      if (resumed.rowCount !== 1) throw new Error("objective_submit_session_projection_conflict")
    }
    const queued = await client.query(`UPDATE "agent_turns" SET "status"='queued',"leaseOwnerId"=NULL,"leaseExpiresAt"=NULL,"leaseStartedAt"=NULL,
      "revision"="revision"+1,"completedAt"=NULL,"updatedAt"=$1 WHERE "id"=$2 AND "sessionId"=$3 AND "userId"=$4 AND "rootTaskId"=$5
        AND "status"='waiting_for_approval' AND "revision"=$6 AND "leaseOwnerId" IS NULL AND "leaseExpiresAt" IS NULL`,
    [now, candidate.turnId, candidate.sessionId, candidate.userId, candidate.rootTaskId, Number(turn.revision)])
    if (queued.rowCount !== 1 || !await persistWakeupTurnDispatchInTransaction(client, candidate.turnId, candidate.sessionId, eventId)) {
      throw new Error("objective_submit_finalization_dispatch_conflict")
    }
    return true
  })
}

async function settledExecution(client: Pick<pg.PoolClient, "query">, candidate: ObjectiveCandidate, task: Row): Promise<ApplicationSubmissionExecution | null> {
  const found = await client.query<Row>(`SELECT "id","actor","body","data" FROM "application_task_events" WHERE "taskId"=$1
    AND "type"='submission_execution_settled' AND "data"->>'fillTurnId'=$2 AND "data"->>'workerTaskId'=$3 LIMIT 2`,
  [task.id, candidate.turnId, task.workerTaskId])
  const event = found.rows[0], data = exactRow(event?.data, ["applicationTaskId", "approvalId", "constraintHash", "executionId", "fillTurnId", "jobId", "sessionId", "userId", "workerTaskId"])
  if (found.rows.length !== 1 || !event || event.actor !== "worker" || event.body !== "Submit execution settled" || !data
    || data.applicationTaskId !== task.id || data.userId !== candidate.userId || data.jobId !== task.jobId
    || data.sessionId !== candidate.sessionId || data.fillTurnId !== candidate.turnId || data.workerTaskId !== task.workerTaskId
    || data.approvalId !== `application-fill:${String(task.id)}:${candidate.turnId}` || !isId(data.executionId)
    || typeof data.constraintHash !== "string" || !/^[a-f0-9]{64}$/.test(data.constraintHash)) return null
  return { applicationTaskId: task.id as string, userId: candidate.userId, jobId: task.jobId as string, sessionId: candidate.sessionId,
    fillTurnId: candidate.turnId, approvalId: data.approvalId as string, constraintHash: data.constraintHash,
    workerTaskId: task.workerTaskId as string, executionId: data.executionId }
}

async function hasOpenSessionPause(client: Pick<pg.PoolClient, "query">, sessionId: string): Promise<boolean> {
  const result = await client.query(`SELECT pause."id" FROM "agent_events" AS pause WHERE pause."sessionId"=$1
    AND pause."actor"='user' AND pause."type"='session.pause_requested' AND NOT EXISTS (
      SELECT 1 FROM "agent_events" AS resumed WHERE resumed."sessionId"=pause."sessionId" AND resumed."turnId"=pause."turnId"
        AND resumed."actor"='user' AND resumed."type"='session.resume_requested' AND resumed."sequence">pause."sequence") LIMIT 1`, [sessionId])
  return result.rows.length > 0
}

function exactRow(value: unknown, keys: readonly string[]): Row | null {
  const row = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!row || typeof row !== "object" || Array.isArray(row)) return null
  try { const own = Reflect.ownKeys(row); if ((Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)
    || own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return null
    if (!own.every(key => { const d = Object.getOwnPropertyDescriptor(row, key); return d?.enumerable === true && Object.hasOwn(d, "value") })) return null
    return row as Row
  } catch { return null }
}
function isId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function date(value: unknown): Date | null { const d = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; return d && Number.isFinite(d.getTime()) ? d : null }

export function startTurnRecoveryScanner(
  pool: LeasePool = getPool(),
  queue: TurnDispatchQueue,
  ownerId = `recovery-${randomUUID()}`,
  intervalMs = TURN_DISPATCH_POLL_MS,
) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new RangeError("Recovery interval must be positive")
  let closed = false
  let inFlight: Promise<unknown> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = recoverTurnQueue(pool, queue, ownerId).catch((error) => {
      console.error("[turn-recovery] scan failed:", error)
    }).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  run()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      await inFlight
    },
  }
}
