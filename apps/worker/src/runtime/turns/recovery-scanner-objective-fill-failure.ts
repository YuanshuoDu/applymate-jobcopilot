import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import { OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, objectiveReviewedFillHandoffIdempotencyKey,
  parseObjectiveReviewedFillSource } from "@jobcopilot/shared"
import type { LeasePool } from "./lease.js"
import { TURN_DISPATCH_MAX_BATCH, withTransaction } from "./recovery-scanner-common.js"

type Client = Pick<PoolClient, "query">
type Row = Record<string, unknown>
type Candidate = { userId: string; sessionId: string; turnId: string; updatedAt: Date | string }
type Cursor = { updatedAt: string; turnId: string }

export const OBJECTIVE_FILL_PRESTART_FAILURE_BODY = "Objective application fill could not start before browser work began." as const
const FAILURE_EVENT = "fill_prestart_failed"
const FAILURE_SCHEMA = "agent-harness.v2.objective-fill-prestart-failure.v1"
const GOAL = "Fill the server-bound application form for user review. Never submit it."
const CONTENT = [{ type: "text", text: GOAL }]
const EVIDENCE_TYPES = ["reviewed_application_fill_browser_started", "form_filled", "submission_queued",
  "submission_execution_started", "submission_execution_settled", "submission_evidence_recorded",
  "objective_submission_manifest_recorded", "objective_application_submit_result_recorded",
  "objective_application_submit_result_recovered", "objective_application_submit_finalization_queued", FAILURE_EVENT]
const cursors = new WeakMap<object, Cursor>()

/** Closes only a rootless failed Objective Fill whose exact queued Task has no browser or submit evidence. */
export async function recoverObjectiveFillPrestartFailures(pool: LeasePool, limit = TURN_DISPATCH_MAX_BATCH, now = new Date()): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return 0
  let candidates: Candidate[]
  try {
    const prior = cursors.get(pool as object)
    candidates = await readCandidates(pool, Math.min(limit, TURN_DISPATCH_MAX_BATCH))
    if (!candidates.length && prior) { cursors.delete(pool as object); candidates = await readCandidates(pool, Math.min(limit, TURN_DISPATCH_MAX_BATCH)) }
  } catch {
    console.error("[turn-recovery] objective fill failure discovery failed")
    return 0
  }
  let failed = 0
  for (const candidate of candidates) {
    try { if (await settleCandidate(pool, candidate, now)) failed += 1 }
    catch { console.error("[turn-recovery] objective fill failure candidate failed") }
  }
  return failed
}

async function readCandidates(pool: LeasePool, limit: number): Promise<Candidate[]> {
  const cursor = cursors.get(pool as object)
  const result = await withTransaction(pool, client => client.query<Candidate>(`SELECT turn."userId",turn."sessionId",turn."id" AS "turnId",turn."updatedAt"
    FROM "agent_sessions" AS session JOIN "agent_turns" AS turn
      ON turn."sessionId"=session."id" AND turn."userId"=session."userId"
    JOIN "application_tasks" AS task ON task."fillTurnId"=turn."id" AND task."fillTurnSessionId"=turn."sessionId"
      AND task."fillTurnUserId"=turn."userId" AND task."userId"=turn."userId" AND task."sessionId"=turn."sessionId"
    WHERE turn."status"='failed' AND turn."rootTaskId" IS NULL AND turn."source"='user'
      AND turn."executionMode"='canonical_task_graph' AND turn."completedAt" IS NOT NULL
      AND turn."leaseOwnerId" IS NULL AND turn."leaseExpiresAt" IS NULL AND turn."leaseStartedAt" IS NULL
      AND turn."input"->'reviewedApplicationMaterialSource'->>'schemaVersion'=$1
      AND task."status"='filling' AND task."checkpoint"='taskgraph_fill_queued' AND task."completedAt" IS NULL
      AND task."workerTaskId" IS NULL
      AND ($2::timestamptz IS NULL OR (turn."updatedAt",turn."id")>($2::timestamptz,$3::text))
    ORDER BY turn."updatedAt" ASC,turn."id" ASC LIMIT $4`,
  [OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, cursor?.updatedAt ?? null, cursor?.turnId ?? null, limit]))
  const last = result.rows[result.rows.length - 1], at = last && date(last.updatedAt)
  if (last && at && id(last.turnId)) cursors.set(pool as object, { updatedAt: at.toISOString(), turnId: last.turnId })
  else if (!last) cursors.delete(pool as object)
  return result.rows.filter((row): row is Candidate => id(row.userId) && id(row.sessionId) && id(row.turnId) && !!date(row.updatedAt))
}

async function settleCandidate(pool: LeasePool, candidate: Candidate, now: Date): Promise<boolean> {
  if (![candidate.userId, candidate.sessionId, candidate.turnId].every(id)) return false
  return withTransaction(pool, async client => {
    await client.query("SELECT set_config($1,$2,true)", ["app.user_id", candidate.userId])
    const session = await client.query<Row>(`SELECT "id","userId" FROM "agent_sessions" WHERE "id"=$1 AND "userId"=$2 FOR UPDATE NOWAIT`,
      [candidate.sessionId, candidate.userId])
    if (session.rows.length !== 1 || session.rows[0]?.id !== candidate.sessionId || session.rows[0]?.userId !== candidate.userId) return false
    const turns = await client.query<Row>(`SELECT "id","userId","sessionId","rootTaskId","source","executionMode","input","status","completedAt",
        "leaseOwnerId","leaseExpiresAt","leaseStartedAt" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 FOR UPDATE NOWAIT`,
      [candidate.turnId, candidate.sessionId, candidate.userId])
    const turn = turns.rows[0], source = parseObjectiveReviewedFillSource(turn?.input)
    const commandKey = source && objectiveReviewedFillHandoffIdempotencyKey(source.approvalId)
    if (turns.rows.length !== 1 || !turn || turn.id !== candidate.turnId || turn.userId !== candidate.userId
      || turn.sessionId !== candidate.sessionId || turn.rootTaskId !== null || turn.source !== "user"
      || turn.executionMode !== "canonical_task_graph" || turn.status !== "failed" || !date(turn.completedAt)
      || turn.leaseOwnerId !== null || turn.leaseExpiresAt !== null || turn.leaseStartedAt !== null || !source || !commandKey
      || !validInput(turn.input, source, commandKey)) return false
    const tasks = await client.query<Row>(`SELECT "id","userId","sessionId","jobId","fillTurnId","fillTurnSessionId","fillTurnUserId",
        "workerTaskId","status","checkpoint","error","completedAt" FROM "application_tasks"
      WHERE "fillTurnId"=$1 AND "userId"=$2 AND "sessionId"=$3 AND "fillTurnSessionId"=$3 AND "fillTurnUserId"=$2
      LIMIT 2 FOR UPDATE NOWAIT`, [candidate.turnId, candidate.userId, candidate.sessionId])
    const task = tasks.rows[0]
    if (tasks.rows.length !== 1 || !task || !id(task.id) || !id(task.jobId) || task.userId !== candidate.userId
      || task.sessionId !== candidate.sessionId || task.fillTurnId !== candidate.turnId || task.fillTurnSessionId !== candidate.sessionId
      || task.fillTurnUserId !== candidate.userId || task.workerTaskId !== null || task.status !== "filling"
      || task.checkpoint !== "taskgraph_fill_queued" || task.error !== null || task.completedAt !== null) return false
    const children = await client.query(`SELECT child."id" FROM "sub_agent_tasks" AS child
      JOIN "agent_turns" AS turn ON turn."id"=child."turnId" AND turn."sessionId"=child."sessionId" AND turn."userId"=$1
      JOIN "agent_sessions" AS session ON session."id"=child."sessionId" AND session."userId"=$1
      WHERE child."sessionId"=$2 AND child."turnId"=$3 LIMIT 1`,
      [candidate.userId, candidate.sessionId, candidate.turnId])
    if (children.rows.length) return false
    if (await hasBrowserOrSubmitEvidence(client, task.id, candidate.turnId, candidate.userId, candidate.sessionId, task.jobId)) return false
    const eventId = failureEventId(task.id, candidate.turnId, commandKey)
    const updated = await client.query(`UPDATE "application_tasks" SET "status"='failed',"checkpoint"='fill_prestart_failed',"error"=$2,"updatedAt"=$3
      WHERE "id"=$1 AND "userId"=$4 AND "sessionId"=$5 AND "jobId"=$6 AND "fillTurnId"=$7
        AND "fillTurnSessionId"=$5 AND "fillTurnUserId"=$4 AND "workerTaskId" IS NULL
        AND "status"='filling' AND "checkpoint"='taskgraph_fill_queued' AND "error" IS NULL AND "completedAt" IS NULL RETURNING "id"`,
    [task.id, OBJECTIVE_FILL_PRESTART_FAILURE_BODY, now, candidate.userId, candidate.sessionId, task.jobId, candidate.turnId])
    if (updated.rowCount !== 1) return false
    const data = { schemaVersion: FAILURE_SCHEMA, applicationTaskId: task.id, userId: candidate.userId,
      sessionId: candidate.sessionId, fillTurnId: candidate.turnId, approvalId: source.approvalId, clientMessageId: commandKey }
    const inserted = await client.query(`INSERT INTO "application_task_events" ("id","taskId","type","actor","body","data","createdAt")
      VALUES ($1,$2,$3,'worker',$4,$5::jsonb,$6) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
    [eventId, task.id, FAILURE_EVENT, OBJECTIVE_FILL_PRESTART_FAILURE_BODY, JSON.stringify(data), now])
    if (inserted.rowCount !== 1) throw new Error("objective_fill_prestart_failure_receipt_conflict")
    return true
  })
}

async function hasBrowserOrSubmitEvidence(client: Client, taskId: string, turnId: string, userId: string, sessionId: string, jobId: string): Promise<boolean> {
  const events = await client.query(`SELECT "id" FROM "application_task_events" WHERE "taskId"=$1 AND "type"=ANY($2::text[])
    AND (COALESCE("data"->>'fillTurnId',"data"->>'turnId',"data"#>>'{scope,fillTurnId}')=$3
      OR COALESCE("data"->>'fillTurnId',"data"->>'turnId',"data"#>>'{scope,fillTurnId}') IS NULL) LIMIT 1`, [taskId, EVIDENCE_TYPES, turnId])
  if (events.rows.length) return true
  const approvals = await client.query(`SELECT "id" FROM "agent_approvals" WHERE "userId"=$1 AND "sessionId"=$2 AND "taskId"=$3
    AND "turnId"=$4 AND "type"='submit_application' LIMIT 1`, [userId, sessionId, taskId, turnId])
  if (approvals.rows.length) return true
  const attempts = await client.query(`SELECT "id" FROM "submission_attempt" WHERE "userId"=$1 AND "jobId"=$2 AND "receiptId"=$3 LIMIT 1`,
    [userId, jobId, `application-fill:${taskId}:${turnId}`])
  return attempts.rows.length > 0
}

function validInput(value: unknown, source: NonNullable<ReturnType<typeof parseObjectiveReviewedFillSource>>, commandKey: string): boolean {
  const row = record(value), marker = parseObjectiveReviewedFillSource(value), content = row?.content
  const part = Array.isArray(content) && content.length === 1 ? record(content[0]) : null
  return exactKeys(row, ["clientMessageId", "content", "goal", "reviewedApplicationMaterialSource"])
    && row?.clientMessageId === commandKey && row.goal === GOAL && exactKeys(part, ["text", "type"])
    && part?.type === "text" && part.text === GOAL && !!marker && marker.approvalId === source.approvalId
    && source.schemaVersion === OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA
}

function failureEventId(taskId: string, turnId: string, commandKey: string): string {
  const hash = createHash("sha256").update(JSON.stringify([taskId, turnId, commandKey])).digest("hex")
  return `objective-fill-prestart-failure:${hash}`
}
function exactKeys(value: Row | null, keys: readonly string[]): boolean {
  if (!value || Reflect.ownKeys(value).length !== keys.length || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) return false
  return keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable === true && Object.hasOwn(d, "value") })
}
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ? value as Row : null } catch { return null }
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function date(value: unknown): Date | null { const d = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; return d && Number.isFinite(d.getTime()) ? d : null }
