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
import { linkAbortSignals } from "../interrupt/bridge.js"
import { RootAbortController, signalWasInterrupted, type RootAbortControllerRegistry } from "../interrupt/registry.js"
import { interruptPollInterval, safePersistedInterrupt, startInterruptProbe, TURN_INTERRUPT_POLL_INTERVAL_MS } from "./turn-interrupt-probe.js"

export { TURN_INTERRUPT_POLL_INTERVAL_MS } from "./turn-interrupt-probe.js"

export const TURN_QUEUE_NAME = "agent-turns"

export type TurnExecutionResult = {
  status: LeaseReleaseStatus
  summary?: string
  /** Durable dependency waits must carry their receipt to the lease handoff. */
  waitId?: string
}

export type TurnExecutor = (input: { lease: TurnLease; signal: AbortSignal }) => Promise<TurnExecutionResult>
export type TurnWaitHandoff = (input: { lease: TurnLease; waitId: string; now: Date }) => Promise<unknown>

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
  /** Optional process-local root shared with TurnCancelService. */
  interrupts?: RootAbortControllerRegistry
  leaseMs?: number
  heartbeatMs?: number
  now?: () => Date
  /** Atomically suspends or requeues a dependency wait before ordinary release. */
  waitHandoff?: TurnWaitHandoff
  /** Server-owned probe for a durable Stop that fenced the active lease. */
  isInterrupted?: (lease: TurnLease) => Promise<boolean>
  /** Bounded cross-process Stop probe interval; omitted means no probe. */
  interruptPollMs?: number
  /** Durable child fence used when this Turn loses ownership unexpectedly. */
  interruptSubagents?: (lease: TurnLease) => Promise<unknown>
}

export async function markTurnDispatchClaimed(pool: LeasePool, payload: TurnJobPayload): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(
      `UPDATE "agent_outbox"
       SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
       WHERE "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $1
         AND "aggregateId" = $2 AND "publishedAt" IS NULL`,
      [`turn-dispatch:${payload.turnId}`, payload.sessionId],
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
  const pollIntervalMs = interruptPollInterval(options.interruptPollMs)

  let lease: TurnLease
  try {
    lease = await claimTurnLease(options.pool, payload, options.now?.() ?? new Date(), options.leaseMs ?? TURN_LEASE_WINDOW_MS)
  } catch (error: unknown) {
    if (error instanceof TurnLeaseError && error.code === "lease_not_available") {
      return { status: "skipped", reasonCode: error.code }
    }
    throw error
  }

  try {
    await markTurnDispatchClaimed(options.pool, payload)
  } catch (error: unknown) {
    // Dispatch bookkeeping is part of the claim boundary. If it fails, put
    // the fenced Turn back in the queue before letting BullMQ retry the job.
    await releaseTurnLease(options.pool, lease, "queued", options.now?.() ?? new Date()).catch(() => undefined)
    throw error
  }
  const heartbeat = new TurnHeartbeat(lease, {
    pool: options.pool,
    intervalMs: options.heartbeatMs,
    now: options.now,
    renew: (current, now) => renewTurnLease(options.pool, current, now, options.leaseMs ?? TURN_LEASE_WINDOW_MS),
    expire: (current, now) => expireTurnLease(options.pool, current, now),
  })
  const active = options.active ?? new TurnExecutionRegistry()
  const target = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId }
  const root = options.interrupts?.getOrCreate(target) ?? (options.isInterrupted ? new RootAbortController(target) : undefined)
  const linked = root ? linkAbortSignals([heartbeat.signal, root.signal]) : { signal: heartbeat.signal, dispose: () => undefined }
  const stopInterruptProbe = root ? startInterruptProbe(options, lease, root, pollIntervalMs) : () => undefined
  active.add({
    lease,
    abort: async () => {
      await heartbeat.abort("Turn interrupted by Worker shutdown")
    },
  })
  heartbeat.start()

  try {
    const result = await Promise.race([
      options.execute({ lease, signal: linked.signal }),
      heartbeat.lost.then((error) => { throw error }),
    ])
    if (result.status === "waiting_for_dependency" && result.waitId && options.waitHandoff) {
      await options.waitHandoff({ lease: heartbeat.currentLease, waitId: result.waitId, now: options.now?.() ?? new Date() })
      return result
    }
    const released = await releaseTurnLease(options.pool, heartbeat.currentLease, result.status, options.now?.() ?? new Date())
    if (!released && (root?.stopped || await safePersistedInterrupt(options.pool, heartbeat.currentLease, options.isInterrupted))) {
      return { status: "interrupted", summary: "Turn stopped by a persisted interrupt" }
    }
    if (!released) throw new TurnLeaseError("lease_lost", "Turn lease was fenced before completion")
    return result
  } catch (error: unknown) {
    if (root?.stopped || signalWasInterrupted(linked.signal)) {
      await releaseTurnLease(options.pool, heartbeat.currentLease, "interrupted", options.now?.() ?? new Date()).catch(() => undefined)
      return { status: "interrupted", summary: "Turn stopped by a persisted interrupt" }
    }
    if (error instanceof TurnLeaseError && error.code === "lease_lost" && await safePersistedInterrupt(options.pool, heartbeat.currentLease, options.isInterrupted)) {
      await releaseTurnLease(options.pool, heartbeat.currentLease, "interrupted", options.now?.() ?? new Date()).catch(() => undefined)
      return { status: "interrupted", summary: "Turn stopped by a persisted interrupt" }
    }
    const decision = classifyTurnFailure(error, job.attemptsMade, TURN_MAX_ATTEMPTS)
    if (decision.disposition === "skip") return { status: "skipped", reasonCode: decision.reasonCode }
    if (decision.disposition === "retry") {
      if (decision.reasonCode === "lease_lost") {
        await options.interruptSubagents?.(heartbeat.currentLease).catch(() => undefined)
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
    stopInterruptProbe()
    linked.dispose()
    if (root) options.interrupts?.release(root.target)
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
  waitHandoff?: TurnWaitHandoff
  queue?: TurnQueueLike
  interrupts?: RootAbortControllerRegistry
  leaseMs?: number
  heartbeatMs?: number
  interruptPollMs?: number
  isInterrupted?: (lease: TurnLease) => Promise<boolean>
  interruptSubagents?: (lease: TurnLease) => Promise<unknown>
}): { queue: TurnQueueLike; worker: Worker<TurnJobPayload>; active: TurnExecutionRegistry; close: () => Promise<void> } {
  const queue = options.queue ?? new Queue<TurnJobPayload>(TURN_QUEUE_NAME, { connection: redisConnection, skipVersionCheck: true })
  const active = new TurnExecutionRegistry()
  const worker = new Worker<TurnJobPayload>(
    TURN_QUEUE_NAME,
    (job) => runTurnJob(job, {
      pool: options.pool,
      execute: options.execute,
      waitHandoff: options.waitHandoff,
      active,
      interrupts: options.interrupts,
      leaseMs: options.leaseMs,
      heartbeatMs: options.heartbeatMs,
      interruptPollMs: options.interruptPollMs,
      isInterrupted: options.isInterrupted ?? (lease => safePersistedInterrupt(options.pool, lease)),
      interruptSubagents: options.interruptSubagents,
    }),
    { connection: redisConnection, concurrency: 1, skipVersionCheck: true, ...workerPollingOptions() },
  )
  return {
    queue, worker, active,
    async close() { await worker.close(); await queue.close() },
  }
}
