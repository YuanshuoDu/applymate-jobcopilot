import { randomUUID } from "node:crypto"
import type pg from "pg"

import { dateValue, DurableSubagentWaitError, object, parseIds, projectDurableSubagentWait, safeSubagentWaitJson } from "./durable-subagent-wait-store.js"
import { persistGraphTransition, prepareGraphTransition } from "./task-graph-pg-lifecycle.js"
import { parseSubagentJobPayload } from "./types.js"
import { taskGraphDeadlineLive } from "./pg-store-claim.js"

type Queryable = Pick<pg.PoolClient, "query">
type Pool = Pick<pg.Pool, "connect">
type Row = Record<string, unknown>
const DEFAULT_BATCH_SIZE = 25
const MAX_BATCH_SIZE = 100
const MAX_TARGETS = 8
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`
const ACTIVE_TURN = `turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`
const ACTIVE_ROOT = `root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`

export type DurableSubagentWaitReconcileOptions = Readonly<{ now?: Date; batchSize?: number; ownerId?: string }>
export type DurableSubagentWaitReconcileReport = Readonly<{ scanned: number; resolved: number; woken: number }>

async function transaction<T>(pool: Pool, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    const value = await work(client)
    await client.query("COMMIT"); committed = true
    return value
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

function validBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) throw new RangeError("Child wait resolver batch size must be between 1 and 100")
  return value
}

function exactTargets(ids: readonly string[], rows: readonly Row[], parentTaskId: string): boolean {
  return ids.length > 0 && ids.length <= MAX_TARGETS && new Set(ids).size === ids.length
    && !ids.includes(parentTaskId) && rows.length === ids.length
    && rows.every(row => ids.includes(String(row.id)) && String(row.parentTaskId) === parentTaskId)
}

async function dispatch(client: Queryable, wait: Row, ownerId: string): Promise<void> {
  const taskId = String(wait.parentTaskId); const sessionId = String(wait.sessionId); const rootTaskId = String(wait.rootTaskId)
  const payload = { taskId, sessionId, rootTaskId, ownerId: `${ownerId}-wait-${randomUUID()}` }
  const written = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    SELECT $1, 'agent.subagent.dispatch', $2, $3, $4::jsonb
    WHERE EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND ${OPEN_SESSION})
    ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL,
      "lastError" = NULL
    WHERE "agent_outbox"."topic" = 'agent.subagent.dispatch' AND "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"
    RETURNING "idempotencyKey"`, [randomUUID(), sessionId, `subagent-dispatch:${taskId}`, JSON.stringify(payload)])
  if (written.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Child wait dispatch could not be fenced")
}

async function fenceBlockedDispatch(client: Queryable, wait: Row): Promise<void> {
  const taskId = String(wait.parentTaskId); const sessionId = String(wait.sessionId); const rootTaskId = String(wait.rootTaskId)
  const idempotencyKey = `subagent-dispatch:${taskId}`
  const found = await client.query<Row>(`SELECT dispatch."id", dispatch."topic", dispatch."aggregateId", dispatch."idempotencyKey", dispatch."payload", dispatch."attemptCount"
    FROM "agent_outbox" AS dispatch WHERE dispatch."idempotencyKey" = $1 FOR UPDATE`, [idempotencyKey])
  if (!found.rows.length) return
  if (found.rows.length !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Child wait dispatch row is ambiguous")
  const row = found.rows[0]
  const payload = parseSubagentJobPayload(row.payload)
  const attemptCount = Number(row.attemptCount)
  if (typeof row.id !== "string" || !row.id.trim() || row.topic !== "agent.subagent.dispatch"
    || row.aggregateId !== sessionId || row.idempotencyKey !== idempotencyKey
    || !payload || payload.taskId !== taskId || payload.sessionId !== sessionId || payload.rootTaskId !== rootTaskId
    || !Number.isSafeInteger(attemptCount) || attemptCount < 0) {
    throw new DurableSubagentWaitError("wait_scope_error", "Child wait dispatch row has invalid scope or generation")
  }
  let ownerId = `child-wait-fence-${randomUUID()}`
  if (ownerId === payload.ownerId) ownerId = `child-wait-fence-${randomUUID()}`
  const fenced = await client.query(`UPDATE "agent_outbox" AS dispatch
    SET "payload" = $1::jsonb, "attemptCount" = dispatch."attemptCount" + 1
    WHERE dispatch."id" = $2 AND dispatch."topic" = $3 AND dispatch."aggregateId" = $4 AND dispatch."idempotencyKey" = $5
      AND dispatch."attemptCount" = $6 AND dispatch."payload"->>'taskId' = $7
      AND dispatch."payload"->>'sessionId' = $8 AND dispatch."payload"->>'rootTaskId' = $9
      AND dispatch."payload"->>'ownerId' = $10 RETURNING dispatch."attemptCount"`,
  [JSON.stringify({ ...payload, ownerId }), row.id, "agent.subagent.dispatch", sessionId, idempotencyKey,
    attemptCount, taskId, sessionId, rootTaskId, payload.ownerId])
  if (fenced.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Child wait dispatch generation could not be fenced")
}

async function reconcileOne(client: Queryable, wait: Row, now: Date, ownerId: string): Promise<"resolved" | "woken" | "waiting" | "ignored"> {
  const parentTaskId = String(wait.parentTaskId); const ids = parseIds(wait.targetTaskIds)
  if (!(wait.mode === "any" || wait.mode === "all") || !ids.length || ids.length > MAX_TARGETS || new Set(ids).size !== ids.length || ids.includes(parentTaskId)) return "ignored"
  const targets = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."sessionId", task."status", task."role", task."result", task."failureReason"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND session."userId" = $5 AND task."parentTaskId" = $6 AND ${OPEN_SESSION} FOR SHARE OF task`,
  [ids, wait.sessionId, wait.turnId, wait.rootTaskId, wait.userId, parentTaskId])).rows
  if (!exactTargets(ids, targets, parentTaskId)) return "ignored"
  const matched = targets.filter(target => TERMINAL.has(String(target.status))).map(target => String(target.id)).sort()
  const deadline = dateValue(wait.deadlineAt, "deadlineAt")
  const status = now >= deadline ? "timed_out" : wait.mode === "any" && matched.length > 0 || wait.mode === "all" && matched.length === ids.length ? "ready" : "waiting"
  if (status === "waiting") return "waiting"
  const graphQueued = await prepareGraphTransition(client, {
    taskId: parentTaskId, sessionId: String(wait.sessionId), type: "task.queued", attemptCount: Number(wait.parentAttempt),
  })
  const existingResult = object(wait.result); const request = object(existingResult.request)
  const outcome = projectDurableSubagentWait({ ...wait, targetTaskIds: ids, deadlineAt: deadline }, targets, status, matched)
  const result = safeSubagentWaitJson({ ...existingResult, request: Object.keys(request).length ? request : { targetTaskIds: ids, mode: wait.mode }, outcome }, 16_384)
  const changed = await client.query(`UPDATE "agent_wait_conditions" SET "status" = $1, "matchedTaskIds" = $2::jsonb,
      "result" = $3::jsonb, "resolvedAt" = COALESCE("resolvedAt", $4), "updatedAt" = $4
    WHERE "id" = $5 AND "userId" = $6 AND "sessionId" = $7 AND "parentTaskId" = $8 AND "status" = 'waiting'
      AND "suspendedAt" IS NOT NULL AND "consumedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS parent JOIN "agent_steps" AS step ON step."id" = "agent_wait_conditions"."stepId"
        WHERE parent."id" = $8 AND parent."sessionId" = $7 AND parent."turnId" = "agent_wait_conditions"."turnId"
          AND (parent."absoluteDeadlineAt" IS NULL OR parent."absoluteDeadlineAt" > clock_timestamp())
          AND step."sessionId" = $7 AND step."turnId" = "agent_wait_conditions"."turnId" AND step."taskId" = $8
          AND step."attempt" = parent."attemptCount" AND step."status" = 'waiting_for_tool'
          AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId" AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt"))
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "agent_wait_conditions"."sessionId" AND ${OPEN_SESSION})`,
  [status, JSON.stringify(matched), JSON.stringify(result), now, wait.id, wait.userId, wait.sessionId, parentTaskId])
  if (changed.rowCount !== 1) return "ignored"
  if (graphQueued && "blocked" in graphQueued) {
    await fenceBlockedDispatch(client, wait)
    if (!await taskGraphDeadlineLive(client, parentTaskId, String(wait.sessionId))) {
      throw new DurableSubagentWaitError("wait_scope_error", "Child wait deadline elapsed during resolution")
    }
    return "resolved"
  }
  const queued = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'queued', "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
      "leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END,
      "nextAttemptAt" = NULL, "completedAt" = NULL, "updatedAt" = $1
    WHERE "id" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "rootTaskId" = $5 AND "attemptCount" = $6
      AND "status" = 'waiting' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "interruptRequestedAt" IS NULL
      AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp())
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = "sub_agent_tasks"."sessionId" AND ${OPEN_SESSION})
      AND EXISTS (SELECT 1 FROM "agent_turns" AS turn WHERE turn."id" = "sub_agent_tasks"."turnId" AND turn."sessionId" = $3 AND ${ACTIVE_TURN})
      AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS root WHERE root."id" = "sub_agent_tasks"."rootTaskId" AND root."sessionId" = $3 AND ${ACTIVE_ROOT})`,
  [now, parentTaskId, wait.sessionId, wait.turnId, wait.rootTaskId, Number(wait.parentAttempt)])
  if (queued.rowCount !== 1) throw new DurableSubagentWaitError("wait_scope_error", "Child wait parent changed before resume")
  await dispatch(client, wait, ownerId)
  if (graphQueued) await persistGraphTransition(client, graphQueued, now)
  if (!await taskGraphDeadlineLive(client, parentTaskId, String(wait.sessionId))) {
    throw new DurableSubagentWaitError("wait_scope_error", "Child wait deadline elapsed during resume")
  }
  return "woken"
}

/** Resolves suspended child waits and queues the same task attempt through the durable outbox. */
export async function reconcileDurableSubagentWaits(pool: Pool, options: DurableSubagentWaitReconcileOptions = {}): Promise<DurableSubagentWaitReconcileReport> {
  const batchSize = validBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE)
  const now = options.now ?? new Date()
  const ownerId = options.ownerId ?? "child-wait-resolver"
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !ownerId.trim() || ownerId.length > 160) throw new TypeError("Child wait resolver options are invalid")
  return transaction(pool, async client => {
    const sessions = await client.query<Row>(`SELECT session."id", session."userId"
      FROM "agent_sessions" AS session WHERE ${OPEN_SESSION} AND EXISTS (
        SELECT 1 FROM "agent_wait_conditions" AS wait
        JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId" AND parent."sessionId" = wait."sessionId" AND parent."turnId" = wait."turnId"
        JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
        JOIN "sub_agent_tasks" AS root ON root."id" = parent."rootTaskId" AND root."sessionId" = wait."sessionId" AND root."turnId" = wait."turnId"
        JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = parent."id"
        WHERE wait."sessionId" = session."id" AND wait."userId" = session."userId" AND wait."status" = 'waiting'
          AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL AND parent."parentTaskId" IS NOT NULL AND parent."status" = 'waiting'
          AND (parent."absoluteDeadlineAt" IS NULL OR parent."absoluteDeadlineAt" > clock_timestamp())
          AND parent."leaseOwner" IS NULL AND parent."leaseExpiresAt" IS NULL AND step."attempt" = parent."attemptCount"
          AND step."status" = 'waiting_for_tool' AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current
            WHERE current."sessionId" = step."sessionId" AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt")
          AND ${ACTIVE_TURN} AND ${ACTIVE_ROOT})
      ORDER BY session."updatedAt" ASC, session."id" ASC LIMIT $1 FOR UPDATE OF session SKIP LOCKED`, [batchSize])
    let scanned = 0; let resolved = 0; let woken = 0
    for (const session of sessions.rows) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [String(session.userId)])
      const waits = await client.query<Row>(`SELECT wait."id", wait."userId", wait."sessionId", wait."turnId", wait."parentTaskId", parent."rootTaskId" AS "rootTaskId", parent."attemptCount" AS "parentAttempt", wait."targetTaskIds", wait."mode", wait."status", wait."deadlineAt", wait."matchedTaskIds", wait."result"
        FROM "agent_wait_conditions" AS wait
        JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId" AND parent."sessionId" = wait."sessionId" AND parent."turnId" = wait."turnId"
        JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
        JOIN "sub_agent_tasks" AS root ON root."id" = parent."rootTaskId" AND root."sessionId" = wait."sessionId" AND root."turnId" = wait."turnId"
        JOIN "agent_sessions" AS session ON session."id" = wait."sessionId" AND session."userId" = wait."userId"
        JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = parent."id"
        WHERE wait."sessionId" = $1 AND wait."userId" = $2 AND wait."status" = 'waiting' AND wait."suspendedAt" IS NOT NULL
          AND wait."consumedAt" IS NULL AND parent."parentTaskId" IS NOT NULL AND parent."status" = 'waiting' AND parent."leaseOwner" IS NULL AND parent."leaseExpiresAt" IS NULL
          AND (parent."absoluteDeadlineAt" IS NULL OR parent."absoluteDeadlineAt" > clock_timestamp())
          AND step."attempt" = parent."attemptCount" AND step."status" = 'waiting_for_tool'
          AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current WHERE current."sessionId" = step."sessionId"
            AND current."turnId" = step."turnId" AND current."taskId" = step."taskId" AND current."attempt" = step."attempt")
          AND ${OPEN_SESSION} AND ${ACTIVE_TURN} AND ${ACTIVE_ROOT}
        ORDER BY wait."createdAt" ASC, wait."id" ASC LIMIT $3 FOR UPDATE OF wait, parent, step SKIP LOCKED`,
      [session.id, session.userId, Math.max(0, batchSize - scanned)])
      for (const wait of waits.rows) {
        scanned += 1
        const outcome = await reconcileOne(client, wait, now, ownerId)
        if (outcome === "resolved" || outcome === "woken") resolved += 1
        if (outcome === "woken") woken += 1
        if (scanned >= batchSize) break
      }
      if (scanned >= batchSize) break
    }
    return { scanned, resolved, woken }
  })
}
