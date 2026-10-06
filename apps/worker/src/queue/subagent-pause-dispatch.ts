import { randomUUID } from "node:crypto"
import type pg from "pg"
import type { AgentTreeManager } from "../runtime/subagents/manager.js"
import { assertSessionWorkAdmission, isSessionPauseRequestedError, OPEN_SESSION, RUNNABLE_SESSION, SESSION_WORK_ADMISSION } from "../runtime/session-gate.js"
import { PAUSE_DEFERRED_MARKER, parseSubagentJobPayload, type PgSubagentPool, type SubagentExecutionResult, type SubagentJobPayload, type SubagentLease } from "../runtime/subagents/types.js"

export { PAUSE_DEFERRED_MARKER }
const DISPATCH_TOPIC = "agent.subagent.dispatch"
const TERMINAL = ["completed", "failed", "interrupted", "cancelled", "closed"]

async function transaction<T>(pool: PgSubagentPool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value }
  catch (error: unknown) { await client.query("ROLLBACK").catch(() => undefined); throw error }
  finally { client.release() }
}

export async function isSubagentDispatchAdmitted(client: Pick<pg.PoolClient, "query">, input: { sessionId: string; userId: string; turnId: string }): Promise<boolean> {
  try { await assertSessionWorkAdmission(client, input); return true }
  catch (error: unknown) { if (isSessionPauseRequestedError(error)) return false; throw error }
}

export async function persistSubagentDispatch(pool: PgSubagentPool, payload: SubagentJobPayload, resetPublished = false): Promise<void> {
  await transaction(pool, async client => {
    const sessionFence = resetPublished ? RUNNABLE_SESSION : OPEN_SESSION
    if (resetPublished) {
      const session = await client.query<{ id: string }>(`SELECT session."id" FROM "agent_sessions" AS session
        WHERE session."id" = $1 AND ${sessionFence} FOR UPDATE`, [payload.sessionId])
      if (!session.rows[0]) return
    }
    const conflict = resetPublished
      ? `ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL,
           "lastError" = CASE WHEN "agent_outbox"."lastError" = $6 THEN "agent_outbox"."lastError" ELSE NULL END,
           "attemptCount" = "agent_outbox"."attemptCount" + 1
         WHERE "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"`
      : `ON CONFLICT ("idempotencyKey") DO NOTHING`
    const values = [randomUUID(), DISPATCH_TOPIC, payload.sessionId, `subagent-dispatch:${payload.taskId}`, JSON.stringify(payload), ...(resetPublished ? [PAUSE_DEFERRED_MARKER] : [])]
    await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") SELECT $1, $2, $3, $4, $5::jsonb
      WHERE EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $3 AND ${sessionFence}) ${conflict}`,
    values)
  })
}

export async function lockAndAdmitSubagentDispatch(client: Pick<pg.PoolClient, "query">, input: { sessionId: string; userId: string; turnId: string }): Promise<boolean> {
  const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
    AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled') FOR UPDATE`, [input.turnId, input.sessionId, input.userId])
  return Boolean(turn.rows[0]) && await isSubagentDispatchAdmitted(client, input)
}

export async function markPauseAwareDispatchError(pool: PgSubagentPool, id: string, error: string, terminal: boolean): Promise<void> {
  const client = await pool.connect()
  try { await client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1,
    "payload" = CASE WHEN "lastError" = $4 THEN jsonb_set("payload", '{ownerId}', to_jsonb($3::text), true) ELSE "payload" END,
    "lastError" = CASE WHEN "lastError" = $4 THEN "lastError" ELSE $2 END,
    "publishedAt" = CASE WHEN $5 THEN CURRENT_TIMESTAMP ELSE "publishedAt" END
    WHERE "id" = $1 AND "publishedAt" IS NULL`, [id, error, `deferred-${randomUUID()}`, PAUSE_DEFERRED_MARKER, terminal]) }
  finally { client.release() }
}

type Executor = (input: { lease: SubagentLease }) => Promise<SubagentExecutionResult>
export async function runSubagentQueueJob(
  pool: PgSubagentPool, manager: Pick<AgentTreeManager, "run">, execute: Executor, payload: SubagentJobPayload,
): Promise<Awaited<ReturnType<AgentTreeManager["run"]>>> {
  const outcome = await manager.run(payload, execute)
  if (outcome.status === "lease_lost") throw new Error(outcome.reason ?? "Subagent lease was lost")
  if (outcome.status === "skipped" && outcome.reason === "session_pause_requested") await deferPauseDeniedDispatch(pool, payload)
  return outcome
}

async function deferPauseDeniedDispatch(pool: PgSubagentPool, payload: SubagentJobPayload): Promise<void> {
  await transaction(pool, async client => {
    const session = await client.query<{ id: string; userId: string }>(`SELECT session."id", session."userId" FROM "agent_sessions" AS session
      WHERE session."id" = $1 AND session."status" NOT IN ('aborted', 'archived') FOR UPDATE`, [payload.sessionId])
    const userId = session.rows[0]?.userId
    if (!userId) return
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const binding = await client.query<{ turnId: string; rootTaskId: string }>(`SELECT task."turnId", task."rootTaskId" FROM "sub_agent_tasks" AS task
      WHERE task."id" = $1 AND task."sessionId" = $2`, [payload.taskId, payload.sessionId])
    const turnId = binding.rows[0]?.turnId
    if (!turnId || binding.rows[0]?.rootTaskId !== payload.rootTaskId) return
    const turn = await client.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
      AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled') FOR UPDATE`, [turnId, payload.sessionId, userId])
    if (!turn.rows[0]) return
    const root = await client.query<Record<string, unknown>>(`SELECT root."id", root."status", root."interruptRequestedAt" FROM "sub_agent_tasks" AS root
      WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3 FOR UPDATE`, [payload.rootTaskId, payload.sessionId, turnId])
    if (!root.rows[0] || root.rows[0].interruptRequestedAt != null || TERMINAL.includes(String(root.rows[0].status))) return
    const task = await client.query<Record<string, unknown>>(`SELECT task."id", task."sessionId", task."rootTaskId", task."turnId", task."status",
        task."startedAt", task."attemptCount", task."maxAttempts", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt"
      FROM "sub_agent_tasks" AS task
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 FOR UPDATE`,
    [payload.taskId, payload.sessionId, turnId, payload.rootTaskId])
    const row = task.rows[0]
    if (!row || row.status !== "queued" || row.startedAt != null
      || row.leaseOwner != null || row.leaseExpiresAt != null || row.interruptRequestedAt != null
      || Number(row.attemptCount) >= Number(row.maxAttempts)) return
    const dispatch = await client.query<{ id: string; payload: unknown; publishedAt: Date | null; lastError: string | null }>(`SELECT dispatch."id", dispatch."payload", dispatch."publishedAt", dispatch."lastError"
      FROM "agent_outbox" AS dispatch WHERE dispatch."topic" = $1 AND dispatch."aggregateId" = $2
        AND dispatch."idempotencyKey" = $3 FOR UPDATE`, [DISPATCH_TOPIC, payload.sessionId, `subagent-dispatch:${payload.taskId}`])
    const current = dispatch.rows[0]
    const currentPayload = current ? parseSubagentJobPayload(current.payload) : null
    if (!current || !currentPayload || currentPayload.ownerId !== payload.ownerId || currentPayload.taskId !== payload.taskId
      || currentPayload.sessionId !== payload.sessionId || currentPayload.rootTaskId !== payload.rootTaskId) return
    if (current.lastError === PAUSE_DEFERRED_MARKER && current.publishedAt !== null) return
    const nextPayload = current.publishedAt === null ? { ...currentPayload, ownerId: `deferred-${randomUUID()}` } : currentPayload
    await client.query(`UPDATE "agent_outbox" SET "lastError" = $2,
      "payload" = CASE WHEN "publishedAt" IS NULL THEN $3::jsonb ELSE "payload" END,
      "attemptCount" = CASE WHEN "publishedAt" IS NULL THEN "attemptCount" + 1 ELSE "attemptCount" END
      WHERE "id" = $1 AND "aggregateId" = $4 AND "topic" = $5
        AND ("lastError" IS DISTINCT FROM $2 OR ("lastError" = $2 AND "publishedAt" IS NULL))
        AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS task
          JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
          JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = $8
          WHERE task."id" = $6 AND task."sessionId" = $4 AND task."rootTaskId" = $7 AND task."status" = 'queued'
            AND task."startedAt" IS NULL AND task."leaseOwner" IS NULL AND task."leaseExpiresAt" IS NULL
            AND task."interruptRequestedAt" IS NULL AND task."attemptCount" < task."maxAttempts"
            AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
            AND root."interruptRequestedAt" IS NULL AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed'))`,
    [current.id, PAUSE_DEFERRED_MARKER, JSON.stringify(nextPayload), payload.sessionId, DISPATCH_TOPIC, payload.taskId, payload.rootTaskId, userId])
  })
}

type DeferredCandidate = { taskId: string; sessionId: string; rootTaskId: string; userId: string; dispatchId: string; payload: unknown }

/** Rotates only a durable pause-denied, published, never-started child after resume. */
export async function repairDeferredSubagentDispatches(pool: PgSubagentPool, ownerId: string, limit = 50): Promise<number> {
  if (!ownerId.trim() || !Number.isInteger(limit) || limit < 1) throw new RangeError("Invalid deferred subagent recovery options")
  const admission = SESSION_WORK_ADMISSION
    .replaceAll("$1", 'session."id"')
    .replaceAll("$2", 'session."userId"')
    .replaceAll("$3", 'task."turnId"')
  return transaction(pool, async client => {
    const sessions = await client.query<{ id: string; userId: string }>(`SELECT session."id", session."userId" FROM "agent_sessions" AS session
      WHERE EXISTS (SELECT 1 FROM "sub_agent_tasks" AS task
        JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
        JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
        JOIN "agent_outbox" AS dispatch ON dispatch."topic" = $1 AND dispatch."aggregateId" = session."id"
          AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
        WHERE task."sessionId" = session."id" AND task."status" = 'queued' AND task."startedAt" IS NULL
          AND task."leaseOwner" IS NULL AND task."leaseExpiresAt" IS NULL AND task."interruptRequestedAt" IS NULL
          AND task."attemptCount" < task."maxAttempts" AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
          AND root."interruptRequestedAt" IS NULL AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
          AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
          AND dispatch."lastError" = $2 AND dispatch."publishedAt" IS NOT NULL AND ${admission})
      ORDER BY session."updatedAt" ASC, session."id" ASC LIMIT $3 FOR UPDATE SKIP LOCKED`, [DISPATCH_TOPIC, PAUSE_DEFERRED_MARKER, limit])
    let repaired = 0
    for (const session of sessions.rows) {
      if (repaired >= limit) break
      await client.query("SELECT set_config('app.user_id', $1, true)", [session.userId])
      const candidates = await client.query<DeferredCandidate>(`SELECT task."id" AS "taskId", task."sessionId", task."rootTaskId", session."userId",
          dispatch."id" AS "dispatchId", dispatch."payload"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
        JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
        JOIN "agent_outbox" AS dispatch ON dispatch."topic" = $2 AND dispatch."aggregateId" = session."id"
          AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
        WHERE session."id" = $1 AND task."status" = 'queued' AND task."startedAt" IS NULL
          AND task."leaseOwner" IS NULL AND task."leaseExpiresAt" IS NULL AND task."interruptRequestedAt" IS NULL
          AND task."attemptCount" < task."maxAttempts" AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
          AND root."interruptRequestedAt" IS NULL AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
          AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
          AND dispatch."lastError" = $3 AND dispatch."publishedAt" IS NOT NULL AND ${admission}
        ORDER BY task."updatedAt" ASC, task."id" ASC LIMIT $4`, [session.id, DISPATCH_TOPIC, PAUSE_DEFERRED_MARKER, limit - repaired])
      for (const candidate of candidates.rows) repaired += await repairDeferredCandidate(client, candidate, ownerId)
    }
    return repaired
  })
}

async function repairDeferredCandidate(client: pg.PoolClient, row: DeferredCandidate, ownerId: string): Promise<number> {
  const binding = await client.query<{ turnId: string }>(`SELECT task."turnId" FROM "sub_agent_tasks" AS task WHERE task."id" = $1 AND task."sessionId" = $2`, [row.taskId, row.sessionId])
  const turnId = binding.rows[0]?.turnId
  if (!turnId || !await lockAndAdmitSubagentDispatch(client, { sessionId: row.sessionId, userId: row.userId, turnId })) return 0
  const root = await client.query<Record<string, unknown>>(`SELECT root."id", root."status", root."interruptRequestedAt" FROM "sub_agent_tasks" AS root
    WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3 FOR UPDATE`, [row.rootTaskId, row.sessionId, turnId])
  if (!root.rows[0] || root.rows[0].interruptRequestedAt != null || TERMINAL.includes(String(root.rows[0].status))) return 0
  const task = await client.query<Record<string, unknown>>(`SELECT task."id", task."sessionId", task."rootTaskId", task."turnId", task."status", task."startedAt",
      task."attemptCount", task."maxAttempts", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt"
    FROM "sub_agent_tasks" AS task
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 FOR UPDATE`,
  [row.taskId, row.sessionId, turnId, row.rootTaskId])
  const currentTask = task.rows[0]
  if (!currentTask || currentTask.status !== "queued" || currentTask.startedAt != null
    || currentTask.leaseOwner != null || currentTask.leaseExpiresAt != null || currentTask.interruptRequestedAt != null
    || Number(currentTask.attemptCount) >= Number(currentTask.maxAttempts)) return 0
  const dispatch = await client.query<{ id: string; payload: unknown; lastError: string | null }>(`SELECT dispatch."id", dispatch."payload", dispatch."lastError" FROM "agent_outbox" AS dispatch
    WHERE dispatch."id" = $1 AND dispatch."aggregateId" = $2 AND dispatch."topic" = $3 AND dispatch."lastError" = $4
      AND dispatch."publishedAt" IS NOT NULL FOR UPDATE`, [row.dispatchId, row.sessionId, DISPATCH_TOPIC, PAUSE_DEFERRED_MARKER])
  const current = dispatch.rows[0]
  const payload = current ? parseSubagentJobPayload(current.payload) : null
  if (!current || !payload || payload.taskId !== row.taskId || payload.sessionId !== row.sessionId || payload.rootTaskId !== row.rootTaskId) return 0
  const nextPayload: SubagentJobPayload = { ...payload, ownerId: `${ownerId}-${randomUUID()}` }
  const admission = SESSION_WORK_ADMISSION
    .replaceAll("$1", 'session."id"')
    .replaceAll("$2", 'session."userId"')
    .replaceAll("$3", 'task."turnId"')
  const updated = await client.query(`UPDATE "agent_outbox" SET "payload" = $1::jsonb, "publishedAt" = NULL,
      "attemptCount" = "attemptCount" + 1 WHERE "id" = $2 AND "aggregateId" = $3 AND "topic" = $4
        AND "lastError" = $5 AND "publishedAt" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS task
          JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
          JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
          WHERE task."id" = $6 AND task."sessionId" = $3 AND task."rootTaskId" = $7 AND task."status" = 'queued'
            AND task."startedAt" IS NULL AND task."leaseOwner" IS NULL AND task."leaseExpiresAt" IS NULL
            AND task."interruptRequestedAt" IS NULL AND task."attemptCount" < task."maxAttempts"
            AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
            AND root."interruptRequestedAt" IS NULL AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') AND ${admission})`,
  [JSON.stringify(nextPayload), row.dispatchId, row.sessionId, DISPATCH_TOPIC, PAUSE_DEFERRED_MARKER, row.taskId, row.rootTaskId])
  return updated.rowCount === 1 ? 1 : 0
}
