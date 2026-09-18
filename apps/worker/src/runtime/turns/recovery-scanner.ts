import { randomUUID } from "node:crypto"

import type pg from "pg"

import { getPool } from "../../db/apply-results.js"
import {
  parseTurnJobPayload,
  type LeasePool,
  type TurnJobPayload,
} from "./lease.js"
import { recordTurnDlq } from "./dlq.js"
import { OPEN_SESSION, RUNNABLE_SESSION } from "../session-gate.js"

export const TURN_DISPATCH_TOPIC = "agent.turn.dispatch"
export const TURN_DISPATCH_POLL_MS = 30_000
export const TURN_DISPATCH_MAX_BATCH = 50

export type TurnDispatchQueue = {
  add(name: string, payload: TurnJobPayload, options?: { jobId?: string; attempts?: number }): Promise<unknown>
}

type OutboxRow = { id: string; aggregateId?: string; payload: unknown; attemptCount?: number }
type QueuedTurnRow = { id: string; sessionId: string }
type ReclaimedTurn = { turnId: string; sessionId: string; previousLeaseVersion: number }
type DispatchOutcome = "skipped" | "published" | "poisoned"
const TURN_DISPATCH_LINEAGE_ERROR = "turn_dispatch_lineage_mismatch"

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
         SELECT turn."id"
         FROM "agent_turns" AS turn
         JOIN "agent_sessions" AS session
           ON session."id" = turn."sessionId"
          AND ${RUNNABLE_SESSION}
         WHERE turn."status" = 'in_progress'
           AND (turn."leaseExpiresAt" IS NULL OR turn."leaseExpiresAt" <= $1)
         ORDER BY turn."updatedAt" ASC, turn."id" ASC
         LIMIT $2 FOR UPDATE OF turn, session SKIP LOCKED
       )
       UPDATE "agent_turns" AS turn
       SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
           "leaseStartedAt" = NULL, "leaseVersion" = "leaseVersion" + 1,
           "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $1
       FROM stale
       WHERE turn."id" = stale."id"
         AND EXISTS (
           SELECT 1 FROM "agent_sessions" AS session
           WHERE session."id" = turn."sessionId"
             AND ${RUNNABLE_SESSION}
         )
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
    if (resetPublished) {
      const session = await client.query<{ id: string }>(
        `SELECT session."id" FROM "agent_sessions" AS session
         WHERE session."id" = $1
           AND ${RUNNABLE_SESSION}
         FOR UPDATE`,
        [payload.sessionId],
      )
      if (!session.rows[0]) return
    }
    const lineage = await client.query<{ id: string }>(
      `SELECT turn."id"
       FROM "agent_turns" AS turn
       JOIN "agent_sessions" AS session
         ON session."id" = turn."sessionId"
        AND session."userId" = turn."userId"
       WHERE turn."id" = $1 AND turn."sessionId" = $2
       FOR UPDATE OF turn, session`,
      [payload.turnId, payload.sessionId],
    )
    if (!lineage.rows[0]) throw new Error(TURN_DISPATCH_LINEAGE_ERROR)
    const conflictClause = resetPublished
      ? `ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL, "attemptCount" = "agent_outbox"."attemptCount" + 1
         WHERE "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"`
      : `ON CONFLICT ("idempotencyKey") DO NOTHING`
    await client.query(
      `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ${conflictClause}`,
      [randomUUID(), TURN_DISPATCH_TOPIC, payload.sessionId, turnDispatchKey(payload.turnId), payloadJson(payload)],
    )
  })
}

/** Rewrites pre-P4-39 pending dispatch rows to their canonical session aggregate. */
export async function repairLegacyTurnDispatchAggregates(pool: LeasePool, limit = TURN_DISPATCH_MAX_BATCH): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Turn dispatch repair limit must be positive")
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `WITH candidates AS (
         SELECT dispatch."id" AS "dispatchId", turn."id" AS "turnId", session."id" AS "sessionId"
         FROM "agent_sessions" AS session
         JOIN "agent_turns" AS turn
           ON turn."sessionId" = session."id"
          AND turn."userId" = session."userId"
         JOIN "agent_outbox" AS dispatch
           ON dispatch."aggregateId" = turn."id"
          AND dispatch."aggregateId" <> session."id"
          AND dispatch."topic" = $1
          AND dispatch."idempotencyKey" = 'turn-dispatch:' || turn."id"
          AND dispatch."publishedAt" IS NULL
          AND dispatch."payload"->>'turnId' = turn."id"
          AND dispatch."payload"->>'sessionId' = session."id"
         WHERE ${OPEN_SESSION}
         ORDER BY dispatch."createdAt" ASC, dispatch."id" ASC
         LIMIT $2 FOR UPDATE OF session, turn, dispatch SKIP LOCKED
       )
       UPDATE "agent_outbox" AS dispatch
       SET "aggregateId" = candidates."sessionId"
       FROM candidates
       WHERE dispatch."id" = candidates."dispatchId"
         AND dispatch."topic" = $1
         AND dispatch."aggregateId" = candidates."turnId"
         AND dispatch."aggregateId" <> candidates."sessionId"
         AND dispatch."idempotencyKey" = 'turn-dispatch:' || candidates."turnId"
         AND dispatch."publishedAt" IS NULL
         AND dispatch."payload"->>'turnId' = candidates."turnId"
         AND dispatch."payload"->>'sessionId' = candidates."sessionId"
       RETURNING dispatch."id"`,
      [TURN_DISPATCH_TOPIC, limit],
    )
    return result.rowCount ?? result.rows.length
  })
}

async function ensureQueuedTurnDispatches(
  pool: LeasePool,
  ownerId: string,
  limit: number,
): Promise<number> {
  // A queued Turn is runnable work even when the agent-runs Redis handoff was
  // lost before turn.started or its canonical dispatch intent was recorded.
  // Rebuild the session-scoped intent so the durable scanner can recover it.
  return withTransaction(pool, async (client) => {
    const rows = await client.query<QueuedTurnRow>(
      `SELECT turn."id", turn."sessionId"
       FROM "agent_turns" AS turn
       JOIN "agent_sessions" AS session
         ON session."id" = turn."sessionId"
        AND ${RUNNABLE_SESSION}
       LEFT JOIN "agent_outbox" AS dispatch
         ON dispatch."topic" = $1
        AND dispatch."aggregateId" = turn."sessionId"
        AND dispatch."idempotencyKey" = 'turn-dispatch:' || turn."id"
       WHERE turn."status" = 'queued'
         AND (
           dispatch."id" IS NULL OR dispatch."publishedAt" IS NOT NULL
         )
       ORDER BY turn."createdAt" ASC, turn."id" ASC
       LIMIT $2 FOR UPDATE OF turn, session SKIP LOCKED`,
      [TURN_DISPATCH_TOPIC, limit],
    )
    let repaired = 0
    for (const row of rows.rows) {
      const payload: TurnJobPayload = { turnId: row.id, sessionId: row.sessionId, ownerId }
      const inserted = await client.query(
        `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
         SELECT $1, $2, $3, $4, $5::jsonb
         WHERE EXISTS (
           SELECT 1 FROM "agent_sessions" AS session
           WHERE session."id" = $3
             AND ${RUNNABLE_SESSION}
         )
         ON CONFLICT ("idempotencyKey") DO UPDATE
         SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL,
             "attemptCount" = "agent_outbox"."attemptCount" + 1
         WHERE "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"`,
         [randomUUID(), TURN_DISPATCH_TOPIC, row.sessionId, turnDispatchKey(row.id), payloadJson(payload)],
       )
      repaired += inserted.rowCount ?? 0
    }
    return repaired
  })
}

export async function dispatchPendingTurnOutbox(
  pool: LeasePool,
  queue: TurnDispatchQueue,
  limit = TURN_DISPATCH_MAX_BATCH,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Turn dispatch limit must be positive")
  const rows = await withTransaction(pool, async (client) => {
    const result = await client.query<OutboxRow>(
      `SELECT dispatch."id", dispatch."aggregateId", dispatch."payload", dispatch."attemptCount"
       FROM "agent_outbox" AS dispatch
       JOIN "agent_sessions" AS session
         ON session."id" = dispatch."aggregateId"
        AND ${RUNNABLE_SESSION}
       WHERE dispatch."topic" = $1 AND dispatch."publishedAt" IS NULL
       ORDER BY dispatch."createdAt" ASC, dispatch."id" ASC
       LIMIT $2 FOR UPDATE OF dispatch, session SKIP LOCKED`,
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
    const sessionId = row.aggregateId ?? payload.sessionId
    let queueAddStarted = false
    let queueAddFailed = false
    let queueAddFailure: unknown
    try {
      const outcome = await withTransaction<DispatchOutcome>(pool, async (client) => {
        // Keep the session fence held across queue.add and the publish mark. A
        // close racing this transaction either waits for delivery to commit
        // or wins first and makes the row ineligible without queueing.
        const session = await client.query<{ id: string }>(
          `SELECT session."id" FROM "agent_sessions" AS session
           WHERE session."id" = $1
             AND ${RUNNABLE_SESSION}
           FOR UPDATE`,
          [sessionId],
        )
        if (!session.rows[0]) return "skipped"
        const pending = await client.query<{ id: string }>(
          `SELECT dispatch."id" FROM "agent_outbox" AS dispatch
           WHERE dispatch."id" = $1 AND dispatch."aggregateId" = $2
             AND dispatch."topic" = $3 AND dispatch."publishedAt" IS NULL
           FOR UPDATE`,
          [row.id, sessionId, TURN_DISPATCH_TOPIC],
        )
        if (!pending.rows[0]) return "skipped"
        const lineageMismatch = (row.aggregateId !== undefined && row.aggregateId !== payload.sessionId) || sessionId !== payload.sessionId
        if (lineageMismatch) {
          await quarantineTurnDispatch(client, row.id)
          return "poisoned"
        }
        const lineage = await client.query<{ id: string }>(
          `SELECT turn."id"
           FROM "agent_turns" AS turn
           JOIN "agent_sessions" AS turnSession
             ON turnSession."id" = turn."sessionId"
            AND turnSession."userId" = turn."userId"
           WHERE turn."id" = $1 AND turn."sessionId" = $2
           FOR UPDATE OF turn, turnSession`,
          [payload.turnId, sessionId],
        )
        if (!lineage.rows[0]) {
          await quarantineTurnDispatch(client, row.id)
          return "poisoned"
        }
        queueAddStarted = true
        try {
          await queue.add("turn", payload, { jobId: turnJobId(payload.turnId, row.attemptCount ?? 0), attempts: 5 })
        } catch (error: unknown) {
          queueAddFailed = true
          queueAddFailure = error
          throw error
        }
        await client.query(
          `UPDATE "agent_outbox"
           SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = NULL
           WHERE "id" = $1 AND "publishedAt" IS NULL`,
          [row.id],
        )
        return "published"
      })
      if (outcome === "skipped") continue
      if (outcome === "poisoned") {
        console.error("[turn-dispatch] quarantined outbox row with invalid session/Turn lineage:", row.id)
        continue
      }
    } catch (error: unknown) {
      if (queueAddFailed) {
        await markDispatchError(pool, row.id, "queue_add_failed")
        throw queueAddFailure ?? error
      }
      // The BullMQ job may already exist. Keep the row unpublished and reuse
      // the same generation/job ID on the next scan instead of inventing a new
      // delivery attempt for an uncertain enqueue.
      if (queueAddStarted) throw new Error("turn_dispatch_delivery_uncertain", { cause: error })
      throw error
    }
    dispatched += 1
  }
  return dispatched
}

async function quarantineTurnDispatch(client: pg.PoolClient, outboxId: string): Promise<void> {
  await client.query(
    `UPDATE "agent_outbox"
     SET "attemptCount" = "attemptCount" + 1, "lastError" = $2,
         "publishedAt" = CURRENT_TIMESTAMP
     WHERE "id" = $1 AND "publishedAt" IS NULL`,
    [outboxId, TURN_DISPATCH_LINEAGE_ERROR],
  )
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
  const legacyRepaired = await repairLegacyTurnDispatchAggregates(pool, TURN_DISPATCH_MAX_BATCH)
  const reclaimed = await reclaimExpiredTurns(pool, now, TURN_DISPATCH_MAX_BATCH)
  for (const turn of reclaimed) {
    await persistTurnDispatch(pool, { turnId: turn.turnId, sessionId: turn.sessionId, ownerId }, true)
  }
  const repaired = legacyRepaired + await ensureQueuedTurnDispatches(pool, ownerId, TURN_DISPATCH_MAX_BATCH)
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
