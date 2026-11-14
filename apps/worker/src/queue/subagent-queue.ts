import { randomUUID } from "node:crypto"
import { Queue, Worker, type Job } from "bullmq"
import type pg from "pg"
import { getPool } from "../db/apply-results.js"
import { redisConnection } from "../redis.js"
import { workerPollingOptions } from "./worker-polling-options.js"
import { repairStaleSubagentDispatches } from "./subagent-dispatch-recovery.js"
import { recoverMissingPublishedSubagentDispatches } from "./subagent-published-dispatch-recovery.js"
import { dispatchTaskInvalidReason, lockDispatchTask, lockPendingDispatch, markDispatchTerminal } from "./subagent-dispatch-eligibility.js"
import { SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "../runtime/subagents/scheduled-gate-contract.js"
import { hasScheduledGateResumeAcknowledgement } from "../runtime/subagents/scheduled-gate-resume-admission.js"
import { lockAndAdmitSubagentDispatch, markPauseAwareDispatchError, PAUSE_DEFERRED_MARKER, persistSubagentDispatch, repairDeferredSubagentDispatches, runSubagentQueueJob } from "./subagent-pause-dispatch.js"
import { runWithSubagentConcurrencyDeferral } from "./subagent-concurrency-deferral.js"
import { AgentTreeManager } from "../runtime/subagents/manager.js"
import { parseSubagentJobPayload, type PgSubagentPool, type SubagentContinuation, type SubagentExecutionResult, type SubagentJobPayload, type SubagentLease } from "../runtime/subagents/types.js"
import { parseSubagentDispatchJobId, subagentDispatchJobId, SUBAGENT_DISPATCH_IDENTITY_MISMATCH } from "../runtime/subagents/dispatch-identity.js"
import { OPEN_SESSION, RUNNABLE_SESSION } from "../runtime/session-gate.js"
import { SUBAGENT_DISPATCH_TOPIC, SUBAGENT_MAX_BATCH, repairMissingSubagentDispatches, subagentDispatchKey } from "./subagent-queue-execution.js"
export { SUBAGENT_DISPATCH_TOPIC, SUBAGENT_MAX_BATCH, repairMissingSubagentDispatches, subagentDispatchKey } from "./subagent-queue-execution.js"
export const SUBAGENT_QUEUE_NAME = "agent-subagents"
export const SUBAGENT_DISPATCH_POLL_MS = 30_000
export { persistSubagentDispatch }
export type SubagentQueueLike = { add(name: string, payload: SubagentJobPayload, options?: { jobId?: string; attempts?: number; delay?: number }): Promise<unknown>; getJob?(jobId: string): Promise<unknown>; close?(): Promise<void> }
/** Queue boundary preserves the complete runtime outcome for manager.run to persist. */
export type SubagentExecutor = (input: { lease: SubagentLease; continuation?: SubagentContinuation }) => Promise<SubagentExecutionResult>
/** BullMQ custom IDs reject colon characters; encode user controlled IDs. */
export function subagentJobId(taskId: string, generation = 0): string {
  return subagentDispatchJobId(taskId, generation)
}
export async function enqueueSubagentTask(queue: SubagentQueueLike, payload: SubagentJobPayload, attempts = 3, generation = 0): Promise<void> {
  if (!parseSubagentJobPayload(payload)) throw new TypeError("Invalid Subagent queue payload"); await queue.add("subagent", payload, { jobId: subagentJobId(payload.taskId, generation), attempts })
}
async function transaction<T>(pool: PgSubagentPool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value }
  catch (error: unknown) { await client.query("ROLLBACK").catch(() => undefined); throw error }
  finally { client.release() }
}
async function lockRunnableDispatchSession(client: Pick<pg.PoolClient, "query">, sessionId: string): Promise<{ id: string; status: string; userId: string } | undefined> {
  const result = await client.query<{ id: string; status: string; userId: string }>(`SELECT session."id", session."status", session."userId" FROM "agent_sessions" AS session WHERE session."id" = $1 AND ${RUNNABLE_SESSION} FOR UPDATE`, [sessionId]); return result.rows[0]
}
async function lockOpenDispatchSession(client: Pick<pg.PoolClient, "query">, sessionId: string): Promise<{ id: string } | undefined> {
  const result = await client.query<{ id: string }>(`SELECT session."id" FROM "agent_sessions" AS session WHERE session."id" = $1 AND ${OPEN_SESSION} FOR UPDATE`, [sessionId]); return result.rows[0]
}
export async function dispatchPendingSubagentOutbox(pool: PgSubagentPool, queue: SubagentQueueLike, limit = SUBAGENT_MAX_BATCH, sessionId?: string): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Subagent dispatch limit must be positive"); if (sessionId !== undefined && !sessionId.trim()) throw new TypeError("Subagent dispatch session filter must be non-empty")
  const rows = await transaction(pool, async client => {
    const result = await client.query<{ id: string; aggregateId: string; payload: unknown; attemptCount?: number }>(`SELECT dispatch."id", dispatch."aggregateId", dispatch."payload", dispatch."attemptCount"
      FROM "agent_outbox" AS dispatch
      LEFT JOIN "agent_sessions" AS session
        ON session."id" = dispatch."aggregateId"
      WHERE dispatch."topic" = $1 AND dispatch."publishedAt" IS NULL AND ($3::text IS NULL OR dispatch."aggregateId" = $3)
        AND (session."id" IS NULL OR ${RUNNABLE_SESSION})
      ORDER BY dispatch."createdAt" ASC, dispatch."id" ASC
      LIMIT $2 FOR UPDATE OF dispatch SKIP LOCKED`, [SUBAGENT_DISPATCH_TOPIC, limit, sessionId ?? null])
    return result.rows
  })
  let dispatched = 0
  for (const row of rows) {
    const scannedPayload = parseSubagentJobPayload(row.payload)
    let queueAddStarted = false
    let queueAddFailed = false
    let queueAddFailure: unknown
    try {
      const published = await transaction(pool, async client => {
        const session = await lockRunnableDispatchSession(client, row.aggregateId)
        if (!session) {
          const openSession = await lockOpenDispatchSession(client, row.aggregateId)
          if (!openSession) {
            const missingSession = await lockPendingDispatch(client, { ...row, topic: SUBAGENT_DISPATCH_TOPIC })
            if (missingSession) await markDispatchTerminal(client, missingSession.id, "session_missing")
          }
          return false
        }
        if (!scannedPayload) {
          const malformed = await lockPendingDispatch(client, { ...row, topic: SUBAGENT_DISPATCH_TOPIC })
          if (malformed) await markDispatchTerminal(client, malformed.id, "schema_invalid_payload")
          return false
        }
        const binding = await client.query<{ id: string; turnId: string | null; rootTaskId: string; role: string; taskType: string }>(`SELECT "id", "turnId", "rootTaskId", "role", "taskType" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [scannedPayload.taskId, row.aggregateId])
        if (!binding.rows[0]) {
          const missing = await lockPendingDispatch(client, { ...row, topic: SUBAGENT_DISPATCH_TOPIC })
          if (missing) await markDispatchTerminal(client, missing.id, "task_missing")
          return false
        }
        const turnId = binding.rows[0].turnId
        if (!turnId) {
          const missing = await lockPendingDispatch(client, { ...row, topic: SUBAGENT_DISPATCH_TOPIC })
          if (missing) await markDispatchTerminal(client, missing.id, "task_turn_missing")
          return false
        }
        if (!await lockAndAdmitSubagentDispatch(client, { sessionId: session.id, userId: session.userId, turnId })) return false
        if (binding.rows[0].role === SCHEDULED_GATE_ROLE && binding.rows[0].taskType === SCHEDULED_GATE_TASK_TYPE) {
          await client.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
            [binding.rows[0].rootTaskId, row.aggregateId, turnId])
        }
        const task = await lockDispatchTask(client, { taskId: scannedPayload.taskId, sessionId: row.aggregateId, userId: session.userId })
        const locked = await lockPendingDispatch(client, { ...row, topic: SUBAGENT_DISPATCH_TOPIC })
        if (!locked) return false
        const payload = parseSubagentJobPayload(locked.payload)
        if (!payload || payload.sessionId !== locked.aggregateId || payload.taskId !== scannedPayload.taskId || payload.rootTaskId !== scannedPayload.rootTaskId) {
          await markDispatchTerminal(client, locked.id, "schema_invalid_payload")
          return false
        }
        if (session.status === "aborted" || session.status === "archived") {
          await markDispatchTerminal(client, locked.id, "session_unavailable")
          return false
        }
        if (task?.scheduledGateResumeCandidate === true && task.role === SCHEDULED_GATE_ROLE && task.taskType === SCHEDULED_GATE_TASK_TYPE
          && task.rootTaskId === scannedPayload.rootTaskId && task.sessionId === row.aggregateId && task.turnId === turnId) {
          task.scheduledGateResumable = await hasScheduledGateResumeAcknowledgement(client, { taskId: scannedPayload.taskId,
            sessionId: row.aggregateId, turnId, rootTaskId: scannedPayload.rootTaskId, userId: session.userId, attemptCount: Number(task.attemptCount) })
        }
        const invalidReason = task ? dispatchTaskInvalidReason(task, payload, session.id, session.userId) : "task_missing"
        if (invalidReason) {
          if (invalidReason === "retry_deferred") return false
          await markDispatchTerminal(client, locked.id, invalidReason)
          return false
        }
        queueAddStarted = true
        try {
          await enqueueSubagentTask(queue, payload, 3, locked.attemptCount ?? row.attemptCount ?? 0)
        } catch (error: unknown) {
          queueAddFailed = true
          queueAddFailure = error
          throw error
        }
        await client.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP,
          "attemptCount" = "attemptCount" + 1,
          "lastError" = CASE WHEN "lastError" = $4 THEN "lastError" ELSE NULL END
          WHERE "id" = $1 AND "aggregateId" = $2 AND "topic" = $3 AND "publishedAt" IS NULL`,
        [locked.id, locked.aggregateId, SUBAGENT_DISPATCH_TOPIC, PAUSE_DEFERRED_MARKER])
        return true
      })
      if (!published) continue
    } catch (error: unknown) {
      if (queueAddFailed) {
        await markPauseAwareDispatchError(pool, row.id, "queue_add_failed", false).catch(() => undefined)
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
export async function recoverSubagentQueue(pool: PgSubagentPool, queue: SubagentQueueLike, manager: AgentTreeManager, limit = SUBAGENT_MAX_BATCH): Promise<{ reclaimed: number; terminal: number; repaired: number; dispatched: number }> {
  const report = await manager.recover(limit)
  for (const task of report.rows) {
    if (task.status !== "queued") continue
    await persistSubagentDispatch(pool, { taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId: `recovery-${randomUUID()}` }, true)
  }
  const repaired = await repairStaleSubagentDispatches(pool, `recovery-${randomUUID()}`, limit)
    + await repairMissingSubagentDispatches(pool, `recovery-${randomUUID()}`, limit)
    + await repairDeferredSubagentDispatches(pool, `recovery-${randomUUID()}`, limit)
    + await recoverMissingPublishedSubagentDispatches(pool, queue, limit)
  const dispatched = await dispatchPendingSubagentOutbox(pool, queue, limit)
  return { reclaimed: report.reclaimed, terminal: report.terminal, repaired, dispatched }
}
export function startSubagentRecoveryScanner(pool: PgSubagentPool = getPool(), queue: SubagentQueueLike, manager: AgentTreeManager, intervalMs = SUBAGENT_DISPATCH_POLL_MS) {
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
  const worker = new Worker<SubagentJobPayload>(SUBAGENT_QUEUE_NAME, async (job: Pick<Job<SubagentJobPayload>, "id" | "data" | "moveToDelayed">, token?: string) => {
    const payload = parseSubagentJobPayload(job.data); if (!payload) throw new TypeError("Invalid Subagent queue payload")
    const identity = parseSubagentDispatchJobId(job.id, payload.taskId)
    if (!identity) return { taskId: payload.taskId, status: "skipped" as const, reason: SUBAGENT_DISPATCH_IDENTITY_MISMATCH }
    return runWithSubagentConcurrencyDeferral({ job, token, run: () => runSubagentQueueJob(getPool(), options.manager, options.execute, payload, identity) })
  }, { connection: redisConnection, skipVersionCheck: true, ...workerPollingOptions(), concurrency: 8 })
  return { queue, worker, async close() { await worker.close(); await queue.close?.() } }
}
