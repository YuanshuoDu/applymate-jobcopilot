import type pg from "pg"

import type { LeasePool, TurnJobPayload } from "./lease.js"

export const TURN_DISPATCH_TOPIC = "agent.turn.dispatch"
export const TURN_DISPATCH_MAX_BATCH = 50
export const TURN_DISPATCH_LINEAGE_ERROR = "turn_dispatch_lineage_mismatch"

export type TurnDispatchJobState = "completed" | "failed" | "delayed" | "active" | "prioritized" | "waiting" | "waiting-children" | "unknown"

export type TurnDispatchQueue = {
  add(name: string, payload: TurnJobPayload, options?: { jobId?: string; attempts?: number }): Promise<unknown>
  // Optional for focused fakes; a published dispatch is never re-armed without a successful state probe.
  getJobState?(jobId: string): Promise<TurnDispatchJobState>
}

type BullQueueJob = { getState(): Promise<string> }
type BullQueueWithJobLookup = TurnDispatchQueue & { getJob?: (jobId: string) => Promise<BullQueueJob | undefined> }

function normalizeTurnDispatchJobState(state: string): TurnDispatchJobState {
  switch (state) {
    case "completed":
    case "failed":
    case "delayed":
    case "active":
    case "prioritized":
    case "waiting":
    case "waiting-children":
    case "unknown":
      return state
    default:
      return "unknown"
  }
}

/** Install the recovery probe on BullMQ Queues without guessing when inspection is unavailable. */
export function attachTurnDispatchStateProbe<T extends TurnDispatchQueue>(queue: T): T {
  const source = queue as T & BullQueueWithJobLookup
  if (queue.getJobState || typeof source.getJob !== "function") return queue

  queue.getJobState = async (jobId) => {
    const job = await source.getJob!.call(queue, jobId)
    if (!job) return "unknown"
    return normalizeTurnDispatchJobState(await job.getState())
  }
  return queue
}

export type ReclaimedTurn = { turnId: string; sessionId: string; previousLeaseVersion: number }

export function turnDispatchKey(turnId: string): string {
  return `turn-dispatch:${turnId}`
}

/** BullMQ custom IDs cannot contain a colon; generation separates resumed work. */
export function turnJobId(turnId: string, generation = 0): string {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("Turn dispatch generation must be a non-negative integer")
  return `agent-turn-${safeJobPart(turnId)}-${generation}`
}

function safeJobPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

export function payloadJson(payload: TurnJobPayload): string {
  return JSON.stringify(payload)
}

export async function withTransaction<T>(pool: LeasePool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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
