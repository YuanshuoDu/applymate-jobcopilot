import type pg from "pg"

import { parseTurnJobPayload, type LeasePool, type TurnJobPayload } from "./lease.js"
import { recordTurnDlq } from "./dlq.js"
import { RUNNABLE_SESSION } from "../session-gate.js"
import {
  TURN_DISPATCH_LINEAGE_ERROR,
  TURN_DISPATCH_MAX_BATCH,
  TURN_DISPATCH_TOPIC,
  turnJobId,
  withTransaction,
  type TurnDispatchQueue,
} from "./recovery-scanner-common.js"

type OutboxRow = { id: string; aggregateId?: string; payload: unknown; attemptCount?: number }
type DispatchOutcome = "skipped" | "published" | "poisoned"

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
