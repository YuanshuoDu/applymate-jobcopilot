import type pg from "pg"

import { parseSubagentJobPayload, type PgSubagentPool, type SubagentJobPayload } from "../runtime/subagents/types.js"
import { RUNNABLE_SESSION } from "../runtime/session-gate.js"

export const SUBAGENT_DISPATCH_TOPIC = "agent.subagent.dispatch"
const DEFAULT_REPAIR_LIMIT = 50

type StaleDispatchRow = {
  taskId: string
  sessionId: string
  rootTaskId: string
  userId: string
  dispatchId: string
  payload: unknown
}

async function transaction<T>(pool: PgSubagentPool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Subagent dispatch limit must be positive")
}

function assertOwnerId(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.trim().length === 0) throw new TypeError("Recovery owner ID must be non-empty")
}

/** Repairs a published dispatch left behind when lease recovery committed first. */
export async function repairStaleSubagentDispatches(
  pool: PgSubagentPool,
  ownerId: string,
  limit = DEFAULT_REPAIR_LIMIT,
): Promise<number> {
  assertLimit(limit)
  assertOwnerId(ownerId)
  return transaction(pool, async client => {
    // Lock sessions first; the candidate query then locks tasks and dispatches.
    const sessions = await client.query<{ id: string }>(`SELECT session."id"
      FROM "agent_sessions" AS session
      WHERE ${RUNNABLE_SESSION}
        AND EXISTS (
          SELECT 1
          FROM "sub_agent_tasks" AS task
          JOIN "sub_agent_tasks" AS root
            ON root."id" = task."rootTaskId"
           AND root."sessionId" = task."sessionId"
           AND root."turnId" = task."turnId"
          JOIN "agent_turns" AS turn
            ON turn."id" = task."turnId"
           AND turn."sessionId" = task."sessionId"
           AND turn."userId" = session."userId"
          JOIN "agent_outbox" AS dispatch
            ON dispatch."topic" = $1
           AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
           AND dispatch."aggregateId" = session."id"
          WHERE task."sessionId" = session."id"
            AND task."status" IN ('queued', 'retrying')
            AND task."startedAt" IS NOT NULL
            AND task."leaseOwner" IS NULL
            AND task."leaseExpiresAt" IS NULL
             AND task."interruptRequestedAt" IS NULL
             AND task."attemptCount" < task."maxAttempts"
             AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
            AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND dispatch."publishedAt" IS NOT NULL
            AND dispatch."publishedAt" < task."updatedAt"
        )
      ORDER BY session."updatedAt" ASC, session."id" ASC
      LIMIT $2 FOR UPDATE SKIP LOCKED`, [SUBAGENT_DISPATCH_TOPIC, limit])
    const sessionIds = sessions.rows.map(row => row.id)
    if (sessionIds.length === 0) return 0

    const candidates = await client.query<StaleDispatchRow>(`SELECT task."id" AS "taskId", task."sessionId", task."rootTaskId", session."userId" AS "userId",
             dispatch."id" AS "dispatchId", dispatch."payload"
      FROM "sub_agent_tasks" AS task
      JOIN "agent_sessions" AS session
        ON session."id" = task."sessionId"
      JOIN "sub_agent_tasks" AS root
        ON root."id" = task."rootTaskId"
       AND root."sessionId" = task."sessionId"
       AND root."turnId" = task."turnId"
      JOIN "agent_turns" AS turn
        ON turn."id" = task."turnId"
       AND turn."sessionId" = task."sessionId"
       AND turn."userId" = session."userId"
      JOIN "agent_outbox" AS dispatch
        ON dispatch."topic" = $2
       AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
       AND dispatch."aggregateId" = session."id"
      WHERE session."id" = ANY($1::text[])
        AND ${RUNNABLE_SESSION}
        AND task."status" IN ('queued', 'retrying')
        AND task."startedAt" IS NOT NULL
        AND task."leaseOwner" IS NULL
        AND task."leaseExpiresAt" IS NULL
        AND task."interruptRequestedAt" IS NULL
        AND task."attemptCount" < task."maxAttempts"
        AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
        AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
        AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
        AND dispatch."publishedAt" IS NOT NULL
        AND dispatch."publishedAt" < task."updatedAt"
      ORDER BY task."updatedAt" ASC, task."id" ASC
      LIMIT $3 FOR UPDATE OF task, dispatch SKIP LOCKED`, [sessionIds, SUBAGENT_DISPATCH_TOPIC, limit])

    let repaired = 0
    for (const row of candidates.rows) {
      const parsed = parseSubagentJobPayload(row.payload)
      if (!parsed || parsed.taskId !== row.taskId || parsed.sessionId !== row.sessionId || parsed.rootTaskId !== row.rootTaskId) continue
      const payload: SubagentJobPayload = { taskId: row.taskId, sessionId: row.sessionId, rootTaskId: row.rootTaskId, ownerId }
      await client.query("SELECT set_config('app.user_id', $1, true)", [row.userId])
      const updated = await client.query(`UPDATE "agent_outbox" AS dispatch
        SET "payload" = $1::jsonb, "publishedAt" = NULL, "lastError" = NULL,
            "attemptCount" = dispatch."attemptCount" + 1
        FROM "sub_agent_tasks" AS task
        JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        JOIN "sub_agent_tasks" AS root
          ON root."id" = task."rootTaskId"
         AND root."sessionId" = task."sessionId"
         AND root."turnId" = task."turnId"
        JOIN "agent_turns" AS turn
          ON turn."id" = task."turnId"
         AND turn."sessionId" = task."sessionId"
         AND turn."userId" = session."userId"
        WHERE dispatch."id" = $2
          AND dispatch."topic" = $3
          AND dispatch."idempotencyKey" = $4
          AND dispatch."aggregateId" = $5
          AND dispatch."publishedAt" IS NOT NULL
          AND dispatch."publishedAt" < task."updatedAt"
          AND task."id" = $6
          AND task."sessionId" = $5
          AND task."rootTaskId" = $7
          AND task."status" IN ('queued', 'retrying')
          AND task."startedAt" IS NOT NULL
          AND task."leaseOwner" IS NULL
          AND task."leaseExpiresAt" IS NULL
          AND task."interruptRequestedAt" IS NULL
          AND task."attemptCount" < task."maxAttempts"
          AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
          AND session."id" = $5
          AND ${RUNNABLE_SESSION}
          AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
          AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`,
      [JSON.stringify(payload), row.dispatchId, SUBAGENT_DISPATCH_TOPIC, `subagent-dispatch:${row.taskId}`, row.sessionId, row.taskId, row.rootTaskId])
      if ((updated.rowCount ?? 0) === 1) repaired += 1
    }
    return repaired
  })
}
