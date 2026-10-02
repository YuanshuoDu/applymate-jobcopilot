import type pg from "pg"

import { transaction } from "./pg-store-persistence.js"
import type { PgSubagentPool } from "./types.js"

const MAX_BATCH_SIZE = 50
const STOPPED_RESULT = JSON.stringify({ status: "interrupted", stepCount: 0, toolCallCount: 0 })
const STOPPED_REASON = "Persisted Stop outlived the Worker lease before a terminal receipt was recorded."

type Candidate = Readonly<{
  id: string
  sessionId: string
  turnId: string
  userId: string
  attemptCount: number
}>

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError("Stopped root recovery limit must be positive")
  return Math.min(value, MAX_BATCH_SIZE)
}

async function appendRootInterruptedNotification(client: pg.PoolClient, candidate: Candidate): Promise<void> {
  const sequenceResult = await client.query<{ eventSequence: string | bigint }>(
    `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
     WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`,
    [candidate.sessionId, candidate.userId],
  )
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("stopped_root_event_sequence_unavailable")

  const eventId = `agent-root-stop-${candidate.id}-attempt-${candidate.attemptCount}`
  const idempotencyKey = `agent-root-stop:${candidate.id}:attempt:${candidate.attemptCount}:task.interrupted`
  const payload = {
    taskId: candidate.id,
    status: "interrupted",
    attemptCount: candidate.attemptCount,
    failureReason: STOPPED_REASON,
  }
  const sequenceText = String(sequence)
  await client.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, NULL, $4, $5, 'task.interrupted', 'system', $3, NULL, $6, $7::jsonb)`, [
    eventId, candidate.sessionId, candidate.turnId, candidate.id, sequenceText, idempotencyKey, JSON.stringify(payload),
  ])
  const outbox = await client.query(`INSERT INTO "agent_outbox"
    ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`, [
    `agent-outbox-${eventId}`,
    candidate.sessionId,
    `agent-event:${eventId}`,
    JSON.stringify({
      eventId, sessionId: candidate.sessionId, turnId: candidate.turnId, itemId: null,
      taskId: candidate.id, sequence: sequenceText, type: "task.interrupted", actor: "system",
      correlationId: candidate.turnId, causationId: null, idempotencyKey, payload,
    }),
  ])
  if (outbox.rowCount !== 1) throw new Error("stopped_root_event_outbox_conflict")
}

/** Terminalize only root tasks whose exact Turn is stopped and Worker lease expired. */
export async function recoverExpiredStoppedRoots(pool: PgSubagentPool, limit = 10): Promise<number> {
  const batchSize = boundedLimit(limit)
  return transaction(pool, async client => {
    const candidates = await client.query<Candidate>(
      `SELECT root."id", root."sessionId", root."turnId", session."userId", root."attemptCount"
       FROM "sub_agent_tasks" AS root
       JOIN "agent_sessions" AS session ON session."id" = root."sessionId"
       JOIN "agent_turns" AS turn ON turn."id" = root."turnId" AND turn."sessionId" = root."sessionId"
       WHERE root."id" = root."rootTaskId" AND root."parentTaskId" IS NULL
         AND turn."rootTaskId" = root."id" AND turn."userId" = session."userId"
         AND turn."status" = 'interrupted' AND root."status" = 'running'
         AND root."interruptRequestedAt" IS NOT NULL
         AND (root."leaseExpiresAt" IS NULL OR root."leaseExpiresAt" <= clock_timestamp())
       ORDER BY root."updatedAt", root."id" LIMIT $1`,
      [batchSize],
    )
    let recovered = 0
    for (const candidate of candidates.rows) {
      const session = await client.query<{ userId: string }>(
        `SELECT "userId" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`,
        [candidate.sessionId],
      )
      if (session.rows[0]?.userId !== candidate.userId) continue
      await client.query("SELECT set_config($1, $2, true)", ["app.user_id", candidate.userId])
      const result = await client.query(
        `UPDATE "sub_agent_tasks" AS root
         SET "status" = 'interrupted', "result" = $5::jsonb, "failureReason" = $6,
             "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL,
             "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
         FROM "agent_sessions" AS session, "agent_turns" AS turn
         WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3
           AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
           AND root."attemptCount" = $4 AND root."status" = 'running'
           AND root."interruptRequestedAt" IS NOT NULL
           AND (root."leaseExpiresAt" IS NULL OR root."leaseExpiresAt" <= clock_timestamp())
           AND session."id" = root."sessionId" AND session."userId" = $7
           AND turn."id" = root."turnId" AND turn."sessionId" = root."sessionId"
           AND turn."rootTaskId" = root."id" AND turn."userId" = session."userId"
           AND turn."status" = 'interrupted'`,
        [candidate.id, candidate.sessionId, candidate.turnId, candidate.attemptCount, STOPPED_RESULT, STOPPED_REASON, candidate.userId],
      )
      if (result.rowCount === 1) {
        await appendRootInterruptedNotification(client, candidate)
        recovered++
      }
    }
    return recovered
  })
}
