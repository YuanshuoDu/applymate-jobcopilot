import { randomUUID } from "node:crypto"
import type pg from "pg"

import type { LeasePool, TurnJobPayload } from "./lease.js"
import { OPEN_SESSION, RUNNABLE_SESSION } from "../session-gate.js"
import {
  payloadJson,
  TURN_DISPATCH_LINEAGE_ERROR,
  TURN_DISPATCH_MAX_BATCH,
  TURN_DISPATCH_TOPIC,
  turnDispatchKey,
  withTransaction,
  type ReclaimedTurn,
} from "./recovery-scanner-common.js"

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

export async function persistTurnDispatch(pool: LeasePool, payload: TurnJobPayload, resetPublished = false): Promise<void> {
  await withTransaction(pool, (client) => persistTurnDispatchInTransaction(client, payload, resetPublished))
}

/** Writes one canonical dispatch intent inside an already-open transaction. */
export async function persistTurnDispatchInTransaction(
  client: Pick<pg.PoolClient, "query">,
  payload: TurnJobPayload,
  resetPublished = false,
  requireRunnableSession = resetPublished,
): Promise<void> {
  if (requireRunnableSession) {
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
  const idempotencyKey = turnDispatchKey(payload.turnId)
  const conflictClause = resetPublished
    ? `ON CONFLICT ("idempotencyKey") DO UPDATE SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL, "attemptCount" = "agent_outbox"."attemptCount" + 1
       WHERE "agent_outbox"."topic" = EXCLUDED."topic"
         AND "agent_outbox"."aggregateId" = EXCLUDED."aggregateId"`
    : `ON CONFLICT ("idempotencyKey") DO NOTHING`
  const written = await client.query(
    `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ${conflictClause}`,
    [randomUUID(), TURN_DISPATCH_TOPIC, payload.sessionId, idempotencyKey, payloadJson(payload)],
  )
  if (resetPublished && written.rowCount !== 1) {
    const conflict = await client.query<{ aggregateId: string; topic: string }>(
      `SELECT "aggregateId", "topic" FROM "agent_outbox"
       WHERE "idempotencyKey" = $1 FOR UPDATE`,
      [idempotencyKey],
    )
    if (conflict.rows[0]?.topic !== TURN_DISPATCH_TOPIC || conflict.rows[0]?.aggregateId !== payload.sessionId) throw new Error(TURN_DISPATCH_LINEAGE_ERROR)
  }
}

/** Adds a wakeup-owned dispatch generation without opening a second transaction. */
export async function persistWakeupTurnDispatchInTransaction(
  client: Pick<pg.PoolClient, "query">,
  turnId: string,
  sessionId: string,
  eventId: string,
): Promise<boolean> {
  try {
    await persistTurnDispatchInTransaction(client, { turnId, sessionId, ownerId: `wakeup:${eventId}` }, true, false)
    return true
  } catch (error) {
    if (error instanceof Error && error.message === TURN_DISPATCH_LINEAGE_ERROR) return false
    throw error
  }
}

/** Rewrites pre-P4-39 dispatch rows to their canonical session aggregate. */
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
         AND dispatch."payload"->>'turnId' = candidates."turnId"
         AND dispatch."payload"->>'sessionId' = candidates."sessionId"
       RETURNING dispatch."id"`,
      [TURN_DISPATCH_TOPIC, limit],
    )
    return result.rowCount ?? result.rows.length
  })
}
