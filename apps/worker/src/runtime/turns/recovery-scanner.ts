import { randomUUID } from "node:crypto"

import type pg from "pg"

import { getPool } from "../../db/apply-results.js"
import {
  parseTurnJobPayload,
  type LeasePool,
  type TurnJobPayload,
} from "./lease.js"
import { recordTurnDlq } from "./dlq.js"

export const TURN_DISPATCH_TOPIC = "agent.turn.dispatch"
export const TURN_DISPATCH_POLL_MS = 30_000
export const TURN_DISPATCH_MAX_BATCH = 50

export type TurnDispatchQueue = {
  add(name: string, payload: TurnJobPayload, options?: { jobId?: string; attempts?: number }): Promise<unknown>
}

type OutboxRow = { id: string; payload: unknown }
type StartedTurnRow = { id: string; sessionId: string }
type ReclaimedTurn = { turnId: string; sessionId: string; previousLeaseVersion: number }

export function turnDispatchKey(turnId: string): string {
  return `turn-dispatch:${turnId}`
}

export function turnJobId(turnId: string): string {
  return `agent-turn:${turnId}`
}

function payloadJson(payload: TurnJobPayload): string {
  return JSON.stringify(payload)
}

async function withTransaction<T>(pool: LeasePool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

/** Reclaims only stale in-progress rows; terminal statuses are never selected. */
export async function reclaimExpiredTurns(pool: LeasePool, now: Date, limit: number): Promise<ReclaimedTurn[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Recovery limit must be positive")
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string; sessionId: string; leaseVersion: number }>(
      `WITH stale AS (
         SELECT "id" FROM "agent_turns"
         WHERE "status" = 'in_progress' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= $1)
         ORDER BY "updatedAt" ASC, "id" ASC FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE "agent_turns" AS turn
       SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
           "leaseStartedAt" = NULL, "leaseVersion" = "leaseVersion" + 1,
           "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $1
       FROM stale WHERE turn."id" = stale."id"
       RETURNING turn."id", turn."sessionId", turn."leaseVersion"`,
      [now, limit],
    )
    return result.rows.map((row) => ({ turnId: row.id, sessionId: row.sessionId, previousLeaseVersion: row.leaseVersion - 1 }))
  })
}

export async function persistTurnDispatch(
  pool: LeasePool,
  payload: TurnJobPayload,
  resetPublished = false,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const conflictClause = resetPublished
      ? `ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL`
      : `ON CONFLICT ("idempotencyKey") DO NOTHING`
    await client.query(
      `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ${conflictClause}`,
      [randomUUID(), TURN_DISPATCH_TOPIC, payload.turnId, turnDispatchKey(payload.turnId), payloadJson(payload)],
    )
  })
}

async function ensureQueuedTurnDispatches(
  pool: LeasePool,
  ownerId: string,
  limit: number,
): Promise<number> {
  // The generic agent.session.event outbox may already be consumed by the
  // stream publisher. Derive dispatch from the canonical turn.started fact so
  // a published event can never strand a queued Turn.
  return withTransaction(pool, async (client) => {
    const rows = await client.query<StartedTurnRow>(
      `SELECT turn."id", turn."sessionId"
       FROM "agent_turns" AS turn
       LEFT JOIN "agent_outbox" AS dispatch
         ON dispatch."topic" = $1 AND dispatch."aggregateId" = turn."id"
       WHERE turn."status" = 'queued'
         AND EXISTS (
           SELECT 1 FROM "agent_events" AS event
           WHERE event."turnId" = turn."id" AND event."type" = 'turn.started'
         )
         AND (
           dispatch."id" IS NULL OR dispatch."publishedAt" IS NOT NULL
         )
       ORDER BY turn."createdAt" ASC, turn."id" ASC
       FOR UPDATE OF turn SKIP LOCKED
       LIMIT $2`,
      [TURN_DISPATCH_TOPIC, limit],
    )
    for (const row of rows.rows) {
      const payload: TurnJobPayload = { turnId: row.id, sessionId: row.sessionId, ownerId }
      await client.query(
        `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT ("idempotencyKey") DO UPDATE
         SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL`,
        [randomUUID(), TURN_DISPATCH_TOPIC, row.id, turnDispatchKey(row.id), payloadJson(payload)],
      )
    }
    return rows.rows.length
  })
}

export async function dispatchPendingTurnOutbox(
  pool: LeasePool,
  queue: TurnDispatchQueue,
  limit = TURN_DISPATCH_MAX_BATCH,
): Promise<number> {
  const rows = await withTransaction(pool, async (client) => {
    const result = await client.query<OutboxRow>(
      `SELECT "id", "payload"
       FROM "agent_outbox"
       WHERE "topic" = $1 AND "publishedAt" IS NULL
       ORDER BY "createdAt" ASC, "id" ASC
       FOR UPDATE SKIP LOCKED LIMIT $2`,
      [TURN_DISPATCH_TOPIC, limit],
    )
    return result.rows
  })
  let dispatched = 0
  for (const row of rows) {
    const payload = parseTurnJobPayload(row.payload)
    if (!payload) {
      await recordTurnDlq(pool, row.payload, 1, "schema_invalid_payload", new Error("Turn dispatch outbox payload is invalid"))
      await markDispatchError(pool, row.id, "schema_invalid_payload", true)
      continue
    }
    await queue.add("turn", payload, { jobId: turnJobId(payload.turnId), attempts: 5 })
    dispatched += 1
  }
  return dispatched
}

async function markDispatchError(pool: LeasePool, outboxId: string, code: string, terminal = false): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(
      `UPDATE "agent_outbox"
       SET "attemptCount" = "attemptCount" + 1, "lastError" = $2,
           "publishedAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "publishedAt" END
       WHERE "id" = $1 AND "publishedAt" IS NULL`,
      [outboxId, code, terminal],
    )
  } finally {
    client.release()
  }
}

export interface RecoveryReport {
  reclaimed: number
  repaired: number
  dispatched: number
}

export async function recoverTurnQueue(
  pool: LeasePool,
  queue: TurnDispatchQueue,
  ownerId = `recovery-${randomUUID()}`,
  now = new Date(),
): Promise<RecoveryReport> {
  const reclaimed = await reclaimExpiredTurns(pool, now, TURN_DISPATCH_MAX_BATCH)
  for (const turn of reclaimed) {
    await persistTurnDispatch(pool, { turnId: turn.turnId, sessionId: turn.sessionId, ownerId }, true)
  }
  const repaired = await ensureQueuedTurnDispatches(pool, ownerId, TURN_DISPATCH_MAX_BATCH)
  const dispatched = await dispatchPendingTurnOutbox(pool, queue)
  return { reclaimed: reclaimed.length, repaired, dispatched }
}

export function startTurnRecoveryScanner(
  pool: LeasePool = getPool(),
  queue: TurnDispatchQueue,
  ownerId = `recovery-${randomUUID()}`,
  intervalMs = TURN_DISPATCH_POLL_MS,
) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new RangeError("Recovery interval must be positive")
  let closed = false
  let inFlight: Promise<unknown> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = recoverTurnQueue(pool, queue, ownerId).catch((error) => {
      console.error("[turn-recovery] scan failed:", error)
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
