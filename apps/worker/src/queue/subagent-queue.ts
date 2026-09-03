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

export function subagentJobId(taskId: string): string { return `agent-subagent:${taskId}` }
export function subagentDispatchKey(taskId: string): string { return `subagent-dispatch:${taskId}` }

export async function enqueueSubagentTask(queue: SubagentQueueLike, payload: SubagentJobPayload, attempts = 3): Promise<void> {
  if (!parseSubagentJobPayload(payload)) throw new TypeError("Invalid Subagent queue payload")
  await queue.add("subagent", payload, { jobId: subagentJobId(payload.taskId), attempts })
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
    const conflict = resetPublished
      ? `ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL`
      : `ON CONFLICT ("idempotencyKey") DO NOTHING`
    await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5::jsonb) ${conflict}`,
    [randomUUID(), SUBAGENT_DISPATCH_TOPIC, payload.taskId, subagentDispatchKey(payload.taskId), JSON.stringify(payload)])
  })
}

export async function dispatchPendingSubagentOutbox(pool: PgSubagentPool, queue: SubagentQueueLike, limit = SUBAGENT_MAX_BATCH): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Subagent dispatch limit must be positive")
  const rows = await transaction(pool, async client => {
    const result = await client.query<{ id: string; payload: unknown }>(`SELECT "id", "payload" FROM "agent_outbox"
      WHERE "topic" = $1 AND "publishedAt" IS NULL ORDER BY "createdAt" ASC, "id" ASC FOR UPDATE SKIP LOCKED LIMIT $2`, [SUBAGENT_DISPATCH_TOPIC, limit])
    return result.rows
  })
  let dispatched = 0
  for (const row of rows) {
    const payload = parseSubagentJobPayload(row.payload)
    if (!payload) {
      await markDispatch(pool, row.id, "schema_invalid_payload", true)
      continue
    }
    await enqueueSubagentTask(queue, payload)
    await markDispatch(pool, row.id, null, true)
    dispatched += 1
  }
  return dispatched
}

async function markDispatch(pool: PgSubagentPool, id: string, error: string | null, published: boolean): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1,
      "lastError" = $2, "publishedAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "publishedAt" END
      WHERE "id" = $1 AND "publishedAt" IS NULL`, [id, error, published])
  } finally { client.release() }
}

export async function recoverSubagentQueue(pool: PgSubagentPool, queue: SubagentQueueLike, manager: AgentTreeManager, limit = SUBAGENT_MAX_BATCH): Promise<{ reclaimed: number; terminal: number; dispatched: number }> {
  const report = await manager.recover(limit)
  for (const task of report.rows) {
    if (task.status !== "queued") continue
    await persistSubagentDispatch(pool, { taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId: `recovery-${randomUUID()}` }, true)
  }
  const dispatched = await dispatchPendingSubagentOutbox(pool, queue, limit)
  return { reclaimed: report.reclaimed, terminal: report.terminal, dispatched }
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

export function createSubagentQueue(options: {
  manager: AgentTreeManager
  execute: SubagentExecutor
  queue?: SubagentQueueLike
}): { queue: SubagentQueueLike; worker: Worker<SubagentJobPayload>; close: () => Promise<void> } {
  const queue = options.queue ?? new Queue<SubagentJobPayload>(SUBAGENT_QUEUE_NAME, { connection: redisConnection, skipVersionCheck: true })
  const worker = new Worker<SubagentJobPayload>(SUBAGENT_QUEUE_NAME, async (job: Pick<Job<SubagentJobPayload>, "data">) => {
    const payload = parseSubagentJobPayload(job.data)
    if (!payload) throw new TypeError("Invalid Subagent queue payload")
    const outcome = await options.manager.run(payload, options.execute)
    if (outcome.status === "retrying" || outcome.status === "lease_lost") throw new Error(outcome.reason ?? "Subagent should be retried")
    return outcome
  }, { connection: redisConnection, skipVersionCheck: true, ...workerPollingOptions(), concurrency: 8 })
  return { queue, worker, async close() { await worker.close(); await queue.close?.() } }
}
