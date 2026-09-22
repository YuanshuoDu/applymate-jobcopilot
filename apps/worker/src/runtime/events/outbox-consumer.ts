import type pg from "pg"

import { publishAgentEvent, type StreamPublisherRedis } from "../../stream/event-publisher.js"
import { matchesCanonicalAgentEvent, parseAgentEventOutboxPayload, toCanonicalAgentEvent, type AgentEventRow } from "./outbox-contract.js"

export const AGENT_EVENT_OUTBOX_TOPIC = "agent.session.event"
const DEFAULT_BATCH_SIZE = 10
const MAX_BATCH_SIZE = 50
const DEFAULT_POLL_MS = 1_000
const RETRY_ERROR = "publish_failed"
const PROCESSING_ERROR = "processing_error"
const TERMINAL_ERRORS = ["schema_invalid_payload", "outbox_scope_mismatch", "event_lineage_mismatch"] as const

type PoolLike = Pick<pg.Pool, "connect">
type Queryable = Pick<pg.PoolClient, "query">
export type AgentEventOutboxPublisher = StreamPublisherRedis
type OutboxRow = { id: string; aggregateId: string; payload: unknown; publishedAt: Date | string | null }
type StartOptions = {
  pollMs?: number
  drain?: (pool: PoolLike, publisher: AgentEventOutboxPublisher, batchSize?: number) => Promise<number>
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE
  if (!Number.isInteger(value) || value < 1) throw new RangeError("Agent event outbox batch size must be positive")
  return Math.min(MAX_BATCH_SIZE, value)
}

async function transaction<T>(pool: PoolLike, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function selectPending(pool: PoolLike, limit: number): Promise<OutboxRow[]> {
  return transaction(pool, async client => (await client.query<OutboxRow>(`SELECT "id", "aggregateId", "payload", "publishedAt"
    FROM "agent_outbox"
    WHERE "topic" = $1 AND "publishedAt" IS NULL
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT $2 FOR UPDATE SKIP LOCKED`, [AGENT_EVENT_OUTBOX_TOPIC, limit])).rows)
}

async function markPublished(client: Queryable, id: string, error: string | null): Promise<void> {
  await client.query(`UPDATE "agent_outbox"
    SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = $2
    WHERE "id" = $1 AND "topic" = $3 AND "publishedAt" IS NULL`, [id, error, AGENT_EVENT_OUTBOX_TOPIC])
}

async function markRetry(pool: PoolLike, id: string, error: string): Promise<void> {
  await transaction(pool, async client => {
    await client.query(`UPDATE "agent_outbox"
      SET "attemptCount" = "attemptCount" + 1, "lastError" = $2
      WHERE "id" = $1 AND "topic" = $3 AND "publishedAt" IS NULL`, [id, error, AGENT_EVENT_OUTBOX_TOPIC])
  })
}

type RowOutcome = "processed" | "retry" | "skipped"

async function processRow(pool: PoolLike, publisher: AgentEventOutboxPublisher, row: OutboxRow): Promise<RowOutcome> {
  let publishStarted = false
  try {
    return await transaction(pool, async client => {
      const current = (await client.query<OutboxRow>(`SELECT "id", "aggregateId", "payload", "publishedAt"
        FROM "agent_outbox" WHERE "id" = $1 AND "topic" = $2 FOR UPDATE`, [row.id, AGENT_EVENT_OUTBOX_TOPIC])).rows[0]
      if (!current || current.publishedAt != null) return "skipped"
      const payload = parseAgentEventOutboxPayload(current.payload)
      if (!payload) { await markPublished(client, current.id, TERMINAL_ERRORS[0]); return "processed" }
      if (current.aggregateId !== payload.sessionId) { await markPublished(client, current.id, TERMINAL_ERRORS[1]); return "processed" }
      const event = (await client.query<AgentEventRow>(`SELECT "id", "sessionId", "turnId", "itemId", "taskId", "sequence",
          "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload", "createdAt"
        FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 FOR SHARE`, [payload.eventId, payload.sessionId])).rows[0]
      const canonical = event && toCanonicalAgentEvent(event)
      if (!canonical || !matchesCanonicalAgentEvent(canonical, payload)) {
        await markPublished(client, current.id, TERMINAL_ERRORS[2])
        return "processed"
      }
      publishStarted = true
      await publishAgentEvent(publisher, canonical)
      await markPublished(client, current.id, null)
      return "processed"
    })
  } catch (error: unknown) {
    await markRetry(pool, row.id, publishStarted ? RETRY_ERROR : PROCESSING_ERROR).catch(() => undefined)
    return "retry"
  }
}

export async function drainAgentEventOutbox(pool: PoolLike, publisher: AgentEventOutboxPublisher, batchSize?: number): Promise<number> {
  const rows = await selectPending(pool, boundedBatchSize(batchSize))
  let processed = 0
  for (const row of rows) if (await processRow(pool, publisher, row) !== "retry") processed += 1
  return processed
}

export function startAgentEventOutboxConsumer(pool: PoolLike, publisher: AgentEventOutboxPublisher, options: StartOptions = {}) {
  const pollMs = Number(options.pollMs ?? process.env.AGENT_EVENT_OUTBOX_POLL_MS ?? DEFAULT_POLL_MS)
  const drain = options.drain ?? drainAgentEventOutbox
  let closed = false
  let inFlight: Promise<void> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = drain(pool, publisher).then(() => undefined).catch(error => console.error("[agent-event-outbox] drain failed:", error)).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, Number.isFinite(pollMs) && pollMs >= 250 && pollMs <= 30_000 ? pollMs : DEFAULT_POLL_MS)
  timer.unref?.()
  run()
  return { async close() { closed = true; clearInterval(timer); await inFlight } }
}
