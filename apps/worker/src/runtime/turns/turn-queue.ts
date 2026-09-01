import { Queue, Worker, type Job } from "bullmq"

import { redisConnection } from "../../redis.js"
import { workerPollingOptions } from "../../queue/worker-polling-options.js"
import {
  claimTurnLease,
  expireTurnLease,
  parseTurnJobPayload,
  releaseTurnLease,
  TurnLeaseError,
  TURN_LEASE_WINDOW_MS,
  renewTurnLease,
  type LeasePool,
  type LeaseReleaseStatus,
  type TurnJobPayload,
  type TurnLease,
} from "./lease.js"
import { TurnHeartbeat } from "./heartbeat.js"
import {
  classifyTurnFailure,
  recordTurnDlq,
  TURN_MAX_ATTEMPTS,
} from "./dlq.js"
import {
  persistTurnDispatch,
  turnJobId,
  type TurnDispatchQueue,
} from "./recovery-scanner.js"

export const TURN_QUEUE_NAME = "agent-turns"

export type TurnExecutionResult = {
  status: LeaseReleaseStatus
  summary?: string
}

export type TurnExecutor = (input: { lease: TurnLease; signal: AbortSignal }) => Promise<TurnExecutionResult>

export type ActiveTurnExecution = {
  lease: TurnLease
  abort: () => Promise<void>
}

export class TurnExecutionRegistry {
  private readonly active = new Map<string, ActiveTurnExecution>()

  add(execution: ActiveTurnExecution): void { this.active.set(execution.lease.turnId, execution) }
  remove(turnId: string): void { this.active.delete(turnId) }
  values(): ActiveTurnExecution[] { return [...this.active.values()] }
  get size(): number { return this.active.size }
}

export interface TurnQueueLike extends TurnDispatchQueue {
  close(): Promise<void>
}

export interface RunTurnJobOptions {
  pool: LeasePool
  execute: TurnExecutor
  active?: TurnExecutionRegistry
  leaseMs?: number
  heartbeatMs?: number
  now?: () => Date
}

export async function markTurnDispatchClaimed(pool: LeasePool, payload: TurnJobPayload): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(
      `UPDATE "agent_outbox"
       SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
       WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1 AND "publishedAt" IS NULL`,
      [`turn-dispatch:${payload.turnId}`],
    )
  } finally {
    client.release()
  }
}

/** The BullMQ processor. Database ownership is established before execute(). */
export async function runTurnJob(
  job: Pick<Job<TurnJobPayload>, "data" | "attemptsMade">,
  options: RunTurnJobOptions,
): Promise<TurnExecutionResult | { status: "skipped" | "dead_lettered" | "requeued"; reasonCode: string }> {
  const payload = parseTurnJobPayload(job.data)
  if (!payload) {
    const error = new Error("Turn queue payload does not match { turnId, sessionId, ownerId }")
    error.name = "TurnQueuePayloadError"
    await recordTurnDlq(options.pool, job.data, job.attemptsMade + 1, "schema_invalid_payload", error)
    return { status: "dead_lettered", reasonCode: "schema_invalid_payload" }
  }

  let lease: TurnLease
  try {
    lease = await claimTurnLease(options.pool, payload, options.now?.() ?? new Date(), options.leaseMs ?? TURN_LEASE_WINDOW_MS)
  } catch (error: unknown) {
    if (error instanceof TurnLeaseError && error.code === "lease_not_available") {
      return { status: "skipped", reasonCode: error.code }
    }
    throw error
  }

  await markTurnDispatchClaimed(options.pool, payload)
  const heartbeat = new TurnHeartbeat(lease, {
    pool: options.pool,
    intervalMs: options.heartbeatMs,
    now: options.now,
    renew: (current, now) => renewTurnLease(options.pool, current, now, options.leaseMs ?? TURN_LEASE_WINDOW_MS),
    expire: (current, now) => expireTurnLease(options.pool, current, now),
  })
  const active = options.active ?? new TurnExecutionRegistry()
  active.add({ lease, abort: () => heartbeat.abort("Turn interrupted by Worker shutdown") })
  heartbeat.start()

  try {
    const result = await Promise.race([
      options.execute({ lease, signal: heartbeat.signal }),
      heartbeat.lost.then((error) => { throw error }),
    ])
    const released = await releaseTurnLease(options.pool, heartbeat.currentLease, result.status, options.now?.() ?? new Date())
    if (!released) throw new TurnLeaseError("lease_lost", "Turn lease was fenced before completion")
    return result
  } catch (error: unknown) {
    const decision = classifyTurnFailure(error, job.attemptsMade, TURN_MAX_ATTEMPTS)
    if (decision.disposition === "skip") return { status: "skipped", reasonCode: decision.reasonCode }
    if (decision.disposition === "retry") {
      if (decision.reasonCode === "lease_lost") {
        await expireTurnLease(options.pool, heartbeat.currentLease, options.now?.() ?? new Date()).catch(() => undefined)
        return { status: "requeued", reasonCode: decision.reasonCode }
      }
      await releaseTurnLease(options.pool, heartbeat.currentLease, "queued", options.now?.() ?? new Date()).catch(() => undefined)
      throw error
    }
    await recordTurnDlq(options.pool, payload, job.attemptsMade + 1, decision.reasonCode, error)
    await releaseTurnLease(options.pool, heartbeat.currentLease, "failed", options.now?.() ?? new Date()).catch(() => undefined)
    return { status: "dead_lettered", reasonCode: decision.reasonCode }
  } finally {
    heartbeat.stop()
    active.remove(lease.turnId)
  }
}

export async function enqueueTurn(
  pool: LeasePool,
  queue: TurnDispatchQueue,
  payload: TurnJobPayload,
): Promise<void> {
  if (!parseTurnJobPayload(payload)) throw new TypeError("Invalid Turn queue payload")
  await persistTurnDispatch(pool, payload)
  await queue.add("turn", payload, { jobId: turnJobId(payload.turnId), attempts: TURN_MAX_ATTEMPTS })
}

export function createTurnQueue(options: {
  pool: LeasePool
  execute: TurnExecutor
  queue?: TurnQueueLike
  leaseMs?: number
  heartbeatMs?: number
}): { queue: TurnQueueLike; worker: Worker<TurnJobPayload>; active: TurnExecutionRegistry; close: () => Promise<void> } {
  const queue = options.queue ?? new Queue<TurnJobPayload>(TURN_QUEUE_NAME, { connection: redisConnection, skipVersionCheck: true })
  const active = new TurnExecutionRegistry()
  const worker = new Worker<TurnJobPayload>(
    TURN_QUEUE_NAME,
    (job) => runTurnJob(job, {
      pool: options.pool,
      execute: options.execute,
      active,
      leaseMs: options.leaseMs,
      heartbeatMs: options.heartbeatMs,
    }),
    { connection: redisConnection, concurrency: 1, skipVersionCheck: true, ...workerPollingOptions() },
  )
  return {
    queue, worker, active,
    async close() { await worker.close(); await queue.close() },
  }
}
