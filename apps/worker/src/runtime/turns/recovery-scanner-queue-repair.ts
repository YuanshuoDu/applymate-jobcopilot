import { randomUUID } from "node:crypto"

import type { LeasePool, TurnJobPayload } from "./lease.js"
import { RUNNABLE_SESSION } from "../session-gate.js"
import {
  TURN_DISPATCH_TOPIC,
  turnDispatchKey,
  turnJobId,
  withTransaction,
  type TurnDispatchQueue,
} from "./recovery-scanner-common.js"

type QueuedTurnRow = {
  id: string
  sessionId: string
  dispatchId: string | null
  dispatchAttemptCount: number | null
  dispatchPublishedAt: string | null
}

// BullMQ reports jobs stored in a globally paused queue's `paused` list as `waiting`.
const LIVE_JOB_STATES = new Set(["active", "delayed", "prioritized", "waiting", "waiting-children"])

function publishedGeneration(attemptCount: number): number {
  return Math.max(0, attemptCount - 1)
}

/** Rebuild missing intents and re-arm published intents only after queue loss is verified. */
export async function ensureQueuedTurnDispatches(
  pool: LeasePool,
  queue: TurnDispatchQueue,
  ownerId: string,
  limit: number,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Recovery limit must be positive")
  const rows = await withTransaction(pool, async client => (await client.query<QueuedTurnRow>(
    `SELECT turn."id", turn."sessionId", dispatch."id" AS "dispatchId",
            dispatch."attemptCount" AS "dispatchAttemptCount",
            dispatch."publishedAt"::text AS "dispatchPublishedAt"
     FROM "agent_turns" AS turn
     JOIN "agent_sessions" AS session
       ON session."id" = turn."sessionId"
      AND ${RUNNABLE_SESSION}
     LEFT JOIN "agent_outbox" AS dispatch
       ON dispatch."topic" = $1
      AND dispatch."aggregateId" = turn."sessionId"
      AND dispatch."idempotencyKey" = 'turn-dispatch:' || turn."id"
     WHERE turn."status" = 'queued' AND turn."leaseOwnerId" IS NULL
       AND (dispatch."id" IS NULL OR dispatch."publishedAt" IS NOT NULL)
     ORDER BY turn."createdAt" ASC, turn."id" ASC
     LIMIT $2 FOR UPDATE OF turn, session SKIP LOCKED`,
    [TURN_DISPATCH_TOPIC, limit],
  )).rows)

  let repaired = 0
  for (const row of rows) {
    const payload: TurnJobPayload = { turnId: row.id, sessionId: row.sessionId, ownerId }
    if (!row.dispatchId) {
      repaired += await insertMissingDispatch(pool, row.id, payload)
      continue
    }
    if (!queue.getJobState || row.dispatchPublishedAt === null) continue

    const attemptCount = Number(row.dispatchAttemptCount ?? 0)
    const generation = publishedGeneration(attemptCount)
    const state = await queue.getJobState(turnJobId(row.id, generation))
    if (LIVE_JOB_STATES.has(state)) continue
    repaired += await rearmMissingPublishedDispatch(pool, row, payload, attemptCount)
  }
  return repaired
}

async function insertMissingDispatch(pool: LeasePool, turnId: string, payload: TurnJobPayload): Promise<number> {
  return withTransaction(pool, async client => {
    const result = await client.query(
      `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
       SELECT $1, $2, $3, $4, $5::jsonb
       WHERE EXISTS (
         SELECT turn."id" FROM "agent_turns" AS turn
         JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
         WHERE turn."id" = $6 AND turn."sessionId" = $3
           AND turn."status" = 'queued' AND turn."leaseOwnerId" IS NULL
           AND ${RUNNABLE_SESSION}
       )
       ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [randomUUID(), TURN_DISPATCH_TOPIC, payload.sessionId, turnDispatchKey(turnId), JSON.stringify(payload), turnId],
    )
    return result.rowCount ?? 0
  })
}

async function rearmMissingPublishedDispatch(
  pool: LeasePool,
  row: QueuedTurnRow,
  payload: TurnJobPayload,
  attemptCount: number,
): Promise<number> {
  if (!row.dispatchId || !row.dispatchPublishedAt) return 0
  return withTransaction(pool, async client => {
    const eligibleTurn = await client.query<{ id: string }>(
      `SELECT turn."id" FROM "agent_turns" AS turn
       JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
       WHERE turn."id" = $1 AND turn."sessionId" = $2
         AND turn."status" = 'queued' AND turn."leaseOwnerId" IS NULL
         AND ${RUNNABLE_SESSION}
       FOR UPDATE OF turn, session`,
      [payload.turnId, payload.sessionId],
    )
    if (!eligibleTurn.rows[0]) return 0

    const result = await client.query(
      `UPDATE "agent_outbox" AS dispatch
       SET "payload" = $1::jsonb, "publishedAt" = NULL, "lastError" = NULL,
           "attemptCount" = dispatch."attemptCount" + 1
       WHERE dispatch."id" = $2 AND dispatch."topic" = $3
         AND dispatch."aggregateId" = $4 AND dispatch."idempotencyKey" = $5
         AND dispatch."attemptCount" = $6 AND dispatch."publishedAt" = $7::timestamptz
         AND EXISTS (
           SELECT turn."id" FROM "agent_turns" AS turn
           JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
           WHERE turn."id" = $8 AND turn."sessionId" = $4
             AND turn."status" = 'queued' AND turn."leaseOwnerId" IS NULL
             AND ${RUNNABLE_SESSION}
         )`,
      [JSON.stringify(payload), row.dispatchId, TURN_DISPATCH_TOPIC, payload.sessionId,
        turnDispatchKey(payload.turnId), attemptCount, row.dispatchPublishedAt, payload.turnId],
    )
    return result.rowCount ?? 0
  })
}
