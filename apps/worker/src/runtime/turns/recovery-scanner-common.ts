import type pg from "pg"

import type { LeasePool, TurnJobPayload } from "./lease.js"

export const TURN_DISPATCH_TOPIC = "agent.turn.dispatch"
export const TURN_DISPATCH_MAX_BATCH = 50
export const TURN_DISPATCH_LINEAGE_ERROR = "turn_dispatch_lineage_mismatch"

export type TurnDispatchQueue = {
  add(name: string, payload: TurnJobPayload, options?: { jobId?: string; attempts?: number }): Promise<unknown>
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
