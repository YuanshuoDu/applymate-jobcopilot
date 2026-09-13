import { randomUUID } from "node:crypto"
import { Queue, Worker, type Job } from "bullmq"
import type pg from "pg"

import { getPool } from "../db/apply-results.js"
import { redisConnection } from "../redis.js"
import { workerPollingOptions } from "./worker-polling-options.js"
import { AgentTreeManager } from "../runtime/subagents/manager.js"
import { parseSubagentJobPayload, type PgSubagentPool, type SubagentJobPayload, type SubagentLease } from "../runtime/subagents/types.js"

export const SUBAGENT_QUEUE_NAME = "agent-subagents"
export const SUBAGENT_DISPATCH_TOPIC = "agent.subagent.dispatch"
export const SUBAGENT_DISPATCH_POLL_MS = 30_000
export const SUBAGENT_MAX_BATCH = 50

export type SubagentQueueLike = {
  add(name: string, payload: SubagentJobPayload, options?: { jobId?: string; attempts?: number; delay?: number }): Promise<unknown>
  close?(): Promise<void>
}

export type SubagentExecutor = (input: { lease: SubagentLease }) => Promise<{ status: "completed" | "waiting" | "waiting_for_user" | "failed"; result?: unknown; failureReason?: string }>
type MissingDispatchRow = { id: string; sessionId: string; rootTaskId: string }

/** BullMQ custom IDs reject colon characters; encode user controlled IDs. */
export function subagentJobId(taskId: string, generation = 0): string {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("Subagent dispatch generation must be a non-negative integer")
  return `agent-subagent-${Buffer.from(taskId, "utf8").toString("base64url")}-${generation}`
}
export function subagentDispatchKey(taskId: string): string { return `subagent-dispatch:${taskId}` }

export async function enqueueSubagentTask(queue: SubagentQueueLike, payload: SubagentJobPayload, attempts = 3, generation = 0): Promise<void> {
  if (!parseSubagentJobPayload(payload)) throw new TypeError("Invalid Subagent queue payload")
  await queue.add("subagent", payload, { jobId: subagentJobId(payload.taskId, generation), attempts })
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
  } finally { client.release() }
}

export async function persistSubagentDispatch(pool: PgSubagentPool, payload: SubagentJobPayload, resetPublished = false): Promise<void> {
  await transaction(pool, async client => {
    if (resetPublished) {
      const session = await client.query<{ id: string }>(`SELECT session."id" FROM "agent_sessions" AS session
        WHERE session."id" = $1 AND session."status" NOT IN ('aborted', 'archived') FOR UPDATE`, [payload.sessionId])
      if (!session.rows[0]) return
    }
    const conflict = resetPublished
      ? `ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL, "attemptCount" = "agent_outbox"."attemptCount" + 1
         WHERE "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"`
      : `ON CONFLICT ("idempotencyKey") DO NOTHING`
    await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      SELECT $1, $2, $3, $4, $5::jsonb
      WHERE EXISTS (SELECT 1 FROM "agent_sessions" AS session
        WHERE session."id" = $3 AND session."status" NOT IN ('aborted', 'archived'))
      ${conflict}`,
    [randomUUID(), SUBAGENT_DISPATCH_TOPIC, payload.sessionId, subagentDispatchKey(payload.taskId), JSON.stringify(payload)])
  })
}

/** Repairs runnable task rows that lost their durable dispatch intent. */
export async function repairMissingSubagentDispatches(pool: PgSubagentPool, ownerId: string, limit = SUBAGENT_MAX_BATCH): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Subagent dispatch limit must be positive")
  return transaction(pool, async client => {
    const openSessions = await client.query<{ id: string }>(`SELECT session."id"
      FROM "agent_sessions" AS session
      WHERE session."status" NOT IN ('aborted', 'archived')
        AND EXISTS (SELECT 1 FROM "sub_agent_tasks" AS task
          JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
          JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
            AND turn."userId" = session."userId"
          LEFT JOIN "agent_outbox" AS dispatch
            ON dispatch."topic" = $1 AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
          WHERE task."sessionId" = session."id" AND task."status" IN ('queued', 'retrying')
            AND task."interruptRequestedAt" IS NULL AND task."attemptCount" < task."maxAttempts"
            AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
            AND dispatch."id" IS NULL)
      ORDER BY session."updatedAt" ASC, session."id" ASC
      LIMIT $2 FOR UPDATE SKIP LOCKED`, [SUBAGENT_DISPATCH_TOPIC, limit])
    const sessionIds = openSessions.rows.map(row => row.id)
    if (sessionIds.length === 0) return 0
    const candidates = await client.query<MissingDispatchRow>(`SELECT task."id", task."sessionId", task."rootTaskId"
      FROM "sub_agent_tasks" AS task
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
        AND turn."userId" = session."userId"
      LEFT JOIN "agent_outbox" AS dispatch
        ON dispatch."topic" = $2 AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
      WHERE task."status" IN ('queued', 'retrying')
        AND task."interruptRequestedAt" IS NULL AND task."attemptCount" < task."maxAttempts"
        AND session."id" = ANY($1::text[])
        AND session."status" NOT IN ('aborted', 'archived')
        AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
        AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
        AND dispatch."id" IS NULL
      ORDER BY task."updatedAt" ASC, task."id" ASC
      LIMIT $3 FOR UPDATE OF task SKIP LOCKED`, [sessionIds, SUBAGENT_DISPATCH_TOPIC, limit])
    let repaired = 0
    for (const row of candidates.rows) {
      const payload: SubagentJobPayload = { taskId: row.id, sessionId: row.sessionId, rootTaskId: row.rootTaskId, ownerId }
      const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        SELECT $1, $2, $3, $4, $5::jsonb
        WHERE EXISTS (SELECT 1 FROM "agent_sessions" AS session
          JOIN "sub_agent_tasks" AS task ON task."sessionId" = session."id"
          JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
          JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
            AND turn."userId" = session."userId"
          WHERE task."id" = $6 AND task."sessionId" = $3 AND task."status" IN ('queued', 'retrying')
            AND task."interruptRequestedAt" IS NULL AND task."attemptCount" < task."maxAttempts"
            AND session."status" NOT IN ('aborted', 'archived')
            AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled'))
        ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [randomUUID(), SUBAGENT_DISPATCH_TOPIC, row.sessionId, subagentDispatchKey(row.id), JSON.stringify(payload), row.id])
      repaired += inserted.rowCount ?? 0
    }
    return repaired
  })
}

export async function dispatchPendingSubagentOutbox(pool: PgSubagentPool, queue: SubagentQueueLike, limit = SUBAGENT_MAX_BATCH): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Subagent dispatch limit must be positive")
  const rows = await transaction(pool, async client => {
    const result = await client.query<{ id: string; aggregateId: string; payload: unknown; attemptCount?: number }>(`SELECT dispatch."id", dispatch."aggregateId", dispatch."payload", dispatch."attemptCount"
      FROM "agent_outbox" AS dispatch
      JOIN "agent_sessions" AS session
        ON session."id" = dispatch."aggregateId"
       AND session."status" NOT IN ('aborted', 'archived')
      WHERE dispatch."topic" = $1 AND dispatch."publishedAt" IS NULL
      ORDER BY dispatch."createdAt" ASC, dispatch."id" ASC
      LIMIT $2 FOR UPDATE OF dispatch, session SKIP LOCKED`, [SUBAGENT_DISPATCH_TOPIC, limit])
    return result.rows
  })
  let dispatched = 0
  for (const row of rows) {
    const payload = parseSubagentJobPayload(row.payload)
    if (!payload || payload.sessionId !== row.aggregateId) {
      await markDispatchError(pool, row.id, "schema_invalid_payload", true)
      continue
    }
    let queueAddStarted = false
    let queueAddFailed = false
    let queueAddFailure: unknown
    try {
      const published = await transaction(pool, async client => {
        // Hold the owning session fence across enqueue and publish marking. A
        // close racing this transaction either waits for delivery or wins first.
        const session = await client.query<{ id: string }>(`SELECT session."id" FROM "agent_sessions" AS session
          WHERE session."id" = $1 AND session."status" NOT IN ('aborted', 'archived') FOR UPDATE`, [row.aggregateId])
        if (!session.rows[0]) return false
        const pending = await client.query<{ id: string }>(`SELECT dispatch."id" FROM "agent_outbox" AS dispatch
          WHERE dispatch."id" = $1 AND dispatch."aggregateId" = $2
            AND dispatch."topic" = $3 AND dispatch."publishedAt" IS NULL FOR UPDATE`,
        [row.id, row.aggregateId, SUBAGENT_DISPATCH_TOPIC])
        if (!pending.rows[0]) return false
        queueAddStarted = true
        try {
          await enqueueSubagentTask(queue, payload, 3, row.attemptCount ?? 0)
        } catch (error: unknown) {
          queueAddFailed = true
          queueAddFailure = error
          throw error
        }
        await client.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP,
          "attemptCount" = "attemptCount" + 1, "lastError" = NULL
          WHERE "id" = $1 AND "aggregateId" = $2 AND "topic" = $3 AND "publishedAt" IS NULL`,
        [row.id, row.aggregateId, SUBAGENT_DISPATCH_TOPIC])
        return true
      })
      if (!published) continue
    } catch (error: unknown) {
      if (queueAddFailed) {
        await markDispatchError(pool, row.id, "queue_add_failed").catch(() => undefined)
        throw queueAddFailure ?? error
      }
      // Delivery is at-least-once; reuse generation/job ID for idempotent retry.
      if (queueAddStarted) throw Object.assign(new Error("subagent_dispatch_delivery_uncertain", { cause: error }), { code: "subagent_dispatch_delivery_uncertain" })
      throw error
    }
    dispatched += 1
  }
  return dispatched
}

async function markDispatchError(pool: PgSubagentPool, id: string, error: string, terminal = false): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1,
      "lastError" = $2, "publishedAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "publishedAt" END
      WHERE "id" = $1 AND "publishedAt" IS NULL`, [id, error, terminal])
  } finally { client.release() }
}

export async function recoverSubagentQueue(pool: PgSubagentPool, queue: SubagentQueueLike, manager: AgentTreeManager, limit = SUBAGENT_MAX_BATCH): Promise<{ reclaimed: number; terminal: number; repaired: number; dispatched: number }> {
  const report = await manager.recover(limit)
  for (const task of report.rows) {
    if (task.status !== "queued") continue
    await persistSubagentDispatch(pool, { taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId: `recovery-${randomUUID()}` }, true)
  }
  const repaired = await repairMissingSubagentDispatches(pool, `recovery-${randomUUID()}`, limit)
  const dispatched = await dispatchPendingSubagentOutbox(pool, queue, limit)
  return { reclaimed: report.reclaimed, terminal: report.terminal, repaired, dispatched }
}

export function startSubagentRecoveryScanner(
  pool: PgSubagentPool = getPool(),
  queue: SubagentQueueLike,
  manager: AgentTreeManager,
  intervalMs = SUBAGENT_DISPATCH_POLL_MS,
) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new RangeError("Recovery interval must be positive")
  let closed = false
  let inFlight: Promise<unknown> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = recoverSubagentQueue(pool, queue, manager).catch(error => {
      console.error("[subagent-recovery] scan failed:", error)
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

export function createSubagentQueue(options: { manager: AgentTreeManager; execute: SubagentExecutor; queue?: SubagentQueueLike }): { queue: SubagentQueueLike; worker: Worker<SubagentJobPayload>; close: () => Promise<void> } {
  const queue = options.queue ?? new Queue<SubagentJobPayload>(SUBAGENT_QUEUE_NAME, { connection: redisConnection, skipVersionCheck: true })
  const worker = new Worker<SubagentJobPayload>(SUBAGENT_QUEUE_NAME, async (job: Pick<Job<SubagentJobPayload>, "data">) => {
    const payload = parseSubagentJobPayload(job.data); if (!payload) throw new TypeError("Invalid Subagent queue payload")
    const outcome = await options.manager.run(payload, options.execute); if (outcome.status === "retrying" || outcome.status === "lease_lost") throw new Error(outcome.reason ?? "Subagent should be retried"); return outcome
  }, { connection: redisConnection, skipVersionCheck: true, ...workerPollingOptions(), concurrency: 8 })
  return { queue, worker, async close() { await worker.close(); await queue.close?.() } }
}
