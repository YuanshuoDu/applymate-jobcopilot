import type pg from "pg"

import { getPool } from "../../db/apply-results.js"

export const SUBAGENT_MAILBOX_OUTBOX_TOPIC = "agent.subagent.mailbox"
const DEFAULT_BATCH_SIZE = 10
const MAX_BATCH_SIZE = 50
const DEFAULT_POLL_MS = 1_000

type PoolLike = Pick<pg.Pool, "connect">
type Queryable = Pick<pg.PoolClient, "query">
type OutboxRow = { id: string; aggregateId: string; payload: unknown }
type MailboxPayload = { messageId: string; sessionId: string; turnId: string; toTaskId: string }
type StartOptions = { pollMs?: number; drain?: (pool: PoolLike, batchSize?: number) => Promise<number> }

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function parseMailboxPayload(value: unknown): MailboxPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(",") !== "messageId,sessionId,toTaskId,turnId") return null
  const { messageId, sessionId, turnId, toTaskId } = row
  if (!nonEmptyString(messageId) || !nonEmptyString(sessionId) || !nonEmptyString(turnId) || !nonEmptyString(toTaskId)) return null
  return { messageId, sessionId, turnId, toTaskId }
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE
  if (!Number.isInteger(value) || value < 1) throw new RangeError("Subagent mailbox outbox batch size must be positive")
  return Math.min(MAX_BATCH_SIZE, value)
}

async function transaction<T>(pool: PoolLike, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function markOutbox(client: Queryable, id: string, lastError: string | null): Promise<void> {
  await client.query(`UPDATE "agent_outbox"
    SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = $2
    WHERE "id" = $1 AND "topic" = $3 AND "publishedAt" IS NULL`, [id, lastError, SUBAGENT_MAILBOX_OUTBOX_TOPIC])
}

async function deliverRow(client: Queryable, row: OutboxRow): Promise<void> {
  const payload = parseMailboxPayload(row.payload)
  if (!payload) {
    await markOutbox(client, row.id, "schema_invalid_payload")
    return
  }
  const session = await client.query<{ id: string; userId: string }>(`SELECT session."id", session."userId"
    FROM "agent_sessions" AS session
    WHERE session."id" = $1 AND session."status" NOT IN ('aborted', 'archived')
    FOR UPDATE`, [row.aggregateId])
  if (!session.rows[0]) {
    await markOutbox(client, row.id, "mailbox_session_unavailable")
    return
  }
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [session.rows[0].userId])
  if (row.aggregateId !== payload.sessionId) {
    await markOutbox(client, row.id, "mailbox_outbox_aggregate_mismatch")
    return
  }
  const message = await client.query<{ id: string; deliveredAt: Date | string | null }>(`SELECT message."id", message."deliveredAt"
    FROM "agent_mailbox_messages" AS message
    JOIN "sub_agent_tasks" AS target
      ON target."id" = message."toTaskId" AND target."sessionId" = message."sessionId"
    JOIN "agent_turns" AS turn
      ON turn."id" = target."turnId" AND turn."sessionId" = target."sessionId"
    WHERE message."id" = $1 AND message."sessionId" = $2 AND message."turnId" = $3
      AND message."toTaskId" = $4 AND target."id" = $4 AND target."sessionId" = $2
      AND target."turnId" = $3 AND turn."id" = $3 AND turn."sessionId" = $2
    FOR UPDATE OF message, target, turn`, [payload.messageId, payload.sessionId, payload.turnId, payload.toTaskId])
  if (!message.rows[0]) {
    await markOutbox(client, row.id, "mailbox_lineage_mismatch")
    return
  }
  if (message.rows[0].deliveredAt === null) {
    await client.query(`UPDATE "agent_mailbox_messages" SET "deliveredAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "toTaskId" = $4 AND "deliveredAt" IS NULL`,
    [payload.messageId, payload.sessionId, payload.turnId, payload.toTaskId])
  }
  await markOutbox(client, row.id, null)
}

export async function drainSubagentMailboxOutbox(pool: PoolLike, batchSize?: number): Promise<number> {
  const limit = boundedBatchSize(batchSize)
  return transaction(pool, async client => {
    const result = await client.query<OutboxRow>(`SELECT "id", "aggregateId", "payload"
      FROM "agent_outbox"
      WHERE "topic" = $1 AND "publishedAt" IS NULL
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT $2 FOR UPDATE SKIP LOCKED`, [SUBAGENT_MAILBOX_OUTBOX_TOPIC, limit])
    for (const row of result.rows) await deliverRow(client, row)
    return result.rows.length
  })
}

export function startSubagentMailboxOutboxConsumer(pool: PoolLike = getPool(), options: StartOptions = {}) {
  const pollMs = Number(options.pollMs ?? process.env.AGENT_MAILBOX_OUTBOX_POLL_MS ?? DEFAULT_POLL_MS)
  const drain = options.drain ?? drainSubagentMailboxOutbox
  let closed = false
  let inFlight: Promise<void> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = drain(pool).then(() => undefined).catch(error => {
      console.error("[agent-mailbox-outbox] drain failed:", error)
    }).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, Number.isFinite(pollMs) && pollMs >= 250 && pollMs <= 30_000 ? pollMs : DEFAULT_POLL_MS)
  timer.unref?.()
  run()
  return { async close() { closed = true; clearInterval(timer); await inFlight } }
}
