import { randomUUID } from "node:crypto"
import type pg from "pg"
import type { PgSubagentPool, SubagentJobPayload } from "../runtime/subagents/types.js"
import { CHILD_WAIT_RESUMABLE_SQL, dispatchTaskInvalidReason, lockDispatchTask } from "./subagent-dispatch-eligibility.js"
import { SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "../runtime/subagents/scheduled-gate-contract.js"
import { hasScheduledGateResumeAcknowledgement, SCHEDULED_GATE_RESUMABLE_SQL } from "../runtime/subagents/scheduled-gate-resume-admission.js"
import { lockAndAdmitSubagentDispatch } from "./subagent-pause-dispatch.js"
import { RUNNABLE_SESSION } from "../runtime/session-gate.js"

export const SUBAGENT_DISPATCH_TOPIC = "agent.subagent.dispatch"
export const SUBAGENT_MAX_BATCH = 50
export function subagentDispatchKey(taskId: string): string { return `subagent-dispatch:${taskId}` }

type MissingDispatchRow = { id: string; sessionId: string; rootTaskId: string }
type MissingGateDispatchRow = MissingDispatchRow & { turnId: string; userId: string }

async function transaction<T>(pool: PgSubagentPool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value }
  catch (error: unknown) { await client.query("ROLLBACK").catch(() => undefined); throw error }
  finally { client.release() }
}

/** Repairs runnable task rows that lost their durable dispatch intent. */
export async function repairMissingSubagentDispatches(pool: PgSubagentPool, ownerId: string, limit = SUBAGENT_MAX_BATCH): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Subagent dispatch limit must be positive")
  return transaction(pool, async client => {
    const openSessions = await client.query<{ id: string }>(`SELECT session."id"
      FROM "agent_sessions" AS session
      WHERE ${RUNNABLE_SESSION}
        AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS task
          JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
          JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
            AND turn."userId" = session."userId"
          LEFT JOIN "agent_outbox" AS dispatch
            ON dispatch."topic" = $1 AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
           WHERE task."sessionId" = session."id" AND task."status" IN ('queued', 'retrying')
             AND task."interruptRequestedAt" IS NULL AND (task."attemptCount" < task."maxAttempts" OR ${CHILD_WAIT_RESUMABLE_SQL} OR ${SCHEDULED_GATE_RESUMABLE_SQL})
             AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
            AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
            AND dispatch."id" IS NULL)
      ORDER BY session."updatedAt" ASC, session."id" ASC
      LIMIT $2 FOR UPDATE SKIP LOCKED`, [SUBAGENT_DISPATCH_TOPIC, limit])
    const sessionIds = openSessions.rows.map(row => row.id)
    if (sessionIds.length === 0) return 0
    const gateCandidates = await client.query<MissingGateDispatchRow>(`SELECT task."id", task."sessionId", task."rootTaskId", task."turnId", session."userId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      LEFT JOIN "agent_outbox" AS dispatch ON dispatch."topic" = $2 AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
      WHERE session."id" = ANY($1::text[]) AND ${RUNNABLE_SESSION} AND dispatch."id" IS NULL AND ${SCHEDULED_GATE_RESUMABLE_SQL}
      ORDER BY task."updatedAt" ASC, task."id" ASC LIMIT $3`, [sessionIds, SUBAGENT_DISPATCH_TOPIC, limit])
    let gateRepaired = 0
    for (const row of gateCandidates.rows) {
      if (!await lockAndAdmitSubagentDispatch(client, { sessionId: row.sessionId, userId: row.userId, turnId: row.turnId })) continue
      await client.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [row.rootTaskId, row.sessionId, row.turnId])
      const task = await lockDispatchTask(client, { taskId: row.id, sessionId: row.sessionId, userId: row.userId })
      if (!task || task.scheduledGateResumeCandidate !== true || task.role !== SCHEDULED_GATE_ROLE || task.taskType !== SCHEDULED_GATE_TASK_TYPE
        || !await hasScheduledGateResumeAcknowledgement(client, { taskId: row.id, sessionId: row.sessionId, turnId: row.turnId,
          rootTaskId: row.rootTaskId, userId: row.userId, attemptCount: Number(task.attemptCount) })) continue
      task.scheduledGateResumable = true
      const payload: SubagentJobPayload = { taskId: row.id, sessionId: row.sessionId, rootTaskId: row.rootTaskId, ownerId }
      if (dispatchTaskInvalidReason(task, payload, row.sessionId, row.userId)) continue
      const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [randomUUID(), SUBAGENT_DISPATCH_TOPIC, row.sessionId, subagentDispatchKey(row.id), JSON.stringify(payload)])
      gateRepaired += inserted.rowCount ?? 0
    }
    const candidates = await client.query<MissingDispatchRow>(`SELECT task."id", task."sessionId", task."rootTaskId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
      LEFT JOIN "agent_outbox" AS dispatch ON dispatch."topic" = $2 AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
      WHERE task."status" IN ('queued', 'retrying') AND task."interruptRequestedAt" IS NULL
        AND (task."attemptCount" < task."maxAttempts" OR ${CHILD_WAIT_RESUMABLE_SQL})
        AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP)
        AND session."id" = ANY($1::text[]) AND ${RUNNABLE_SESSION}
        AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
        AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled') AND dispatch."id" IS NULL
      ORDER BY task."updatedAt" ASC, task."id" ASC LIMIT $3 FOR UPDATE OF task SKIP LOCKED`,
    [sessionIds, SUBAGENT_DISPATCH_TOPIC, Math.max(0, limit - gateRepaired)])
    let repaired = 0
    for (const row of candidates.rows) {
      const payload: SubagentJobPayload = { taskId: row.id, sessionId: row.sessionId, rootTaskId: row.rootTaskId, ownerId }
      const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        SELECT $1, $2, $3, $4, $5::jsonb WHERE EXISTS (SELECT 1 FROM "agent_sessions" AS session
          JOIN "sub_agent_tasks" AS task ON task."sessionId" = session."id"
          JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
          JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = session."userId"
          WHERE task."id" = $6 AND task."sessionId" = $3 AND task."status" IN ('queued', 'retrying')
            AND task."interruptRequestedAt" IS NULL AND (task."attemptCount" < task."maxAttempts" OR ${CHILD_WAIT_RESUMABLE_SQL})
            AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= CURRENT_TIMESTAMP) AND ${RUNNABLE_SESSION}
            AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))
        ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [randomUUID(), SUBAGENT_DISPATCH_TOPIC, row.sessionId, subagentDispatchKey(row.id), JSON.stringify(payload), row.id])
      repaired += inserted.rowCount ?? 0
    }
    return repaired + gateRepaired
  })
}
