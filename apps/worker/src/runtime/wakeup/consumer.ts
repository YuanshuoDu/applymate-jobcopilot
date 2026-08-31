import { randomUUID } from "node:crypto"
import type pg from "pg"

import { getPool } from "../../db/apply-results.js"
import { AGENT_TURN_WAKEUP_TOPIC, parseWakeup, type AgentTurnWakeupPayload, type WakeupResult } from "./types.js"

type Client = pg.PoolClient
type PoolLike = Pick<pg.Pool, "connect">

interface OutboxRow {
  id: string
  payload: unknown
}

const DEFAULT_BATCH_SIZE = 10
const DEFAULT_POLL_MS = 1_000

function json(value: unknown): string {
  return JSON.stringify(value)
}

async function appendResumeEvent(client: Client, payload: AgentTurnWakeupPayload): Promise<void> {
  const sequenceResult = await client.query<{ eventSequence: string | bigint }>(
    `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`,
    [payload.sessionId],
  )
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("Agent session sequence is unavailable for wakeup")
  const eventId = randomUUID()
  const eventPayload = {
    waitKind: payload.waitKind,
    waitId: payload.waitId,
    itemId: payload.itemId,
    turnId: payload.turnId,
    toolCallId: payload.toolCallId,
    status: payload.status,
    resumedFromEventId: payload.eventId,
  }
  await client.query(
    `INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, NULL, $5, 'turn.resumed', 'system', $3, $6, $7, $8::jsonb)`,
    [eventId, payload.sessionId, payload.turnId, payload.itemId, String(sequence), payload.eventId, `agent-wakeup:${payload.eventId}:resumed`, json(eventPayload)],
  )
  await client.query(
    `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`,
    [`agent-outbox-${eventId}`, payload.sessionId, `agent-event:${eventId}`, json({
      eventId, sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId,
      taskId: null, sequence: String(sequence), type: "turn.resumed", actor: "system",
      correlationId: payload.turnId, causationId: payload.eventId, idempotencyKey: `agent-wakeup:${payload.eventId}:resumed`, payload: eventPayload,
    })],
  )
}

async function resumeInTransaction(client: Client, payload: AgentTurnWakeupPayload): Promise<WakeupResult> {
  const turnResult = await client.query<{ userId: string; status: string; revision: number }>(
    `SELECT turn."userId", turn."status", turn."revision" FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 FOR UPDATE`,
    [payload.turnId, payload.sessionId],
  )
  const turn = turnResult.rows[0]
  if (!turn) return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await client.query(`SELECT set_config($1, $2, true)`, ["app.user_id", turn.userId])

  if (turn.status === "queued" || turn.status === "in_progress") {
    return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  }
  if (turn.status !== "waiting_for_approval" && turn.status !== "waiting_for_user") {
    return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  }
  if (turn.revision !== payload.nextTurnRevision) throw new Error("Agent Turn revision changed before wakeup")

  const itemResult = await client.query<{ status: string; content: unknown }>(
    `SELECT "status", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
    [payload.itemId, payload.sessionId, payload.turnId],
  )
  const item = itemResult.rows[0]
  if (!item || item.status !== "completed") return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  const content = item.content && typeof item.content === "object" && !Array.isArray(item.content) ? item.content as Record<string, unknown> : {}
  const itemToolCallId = typeof content.toolCallId === "string" ? content.toolCallId : null
  if (itemToolCallId !== payload.toolCallId) throw new Error("Agent wait tool lineage does not match wakeup")

  const updated = await client.query(
    `UPDATE "agent_turns" SET "status" = 'queued', "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "sessionId" = $2 AND "status" IN ('waiting_for_approval', 'waiting_for_user') AND "revision" = $3`,
    [payload.turnId, payload.sessionId, payload.nextTurnRevision],
  )
  if (updated.rowCount !== 1) return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await appendResumeEvent(client, payload)
  return { status: "resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
}

export async function resumeAgentTurn(pool: PoolLike, payload: AgentTurnWakeupPayload): Promise<WakeupResult> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await resumeInTransaction(client, payload)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function drainAgentWakeups(pool: PoolLike, batchSize = DEFAULT_BATCH_SIZE): Promise<number> {
  let processed = 0
  for (;;) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const rows = await client.query<OutboxRow>(
        `SELECT "id", "payload" FROM "agent_outbox" WHERE "topic" = $1 AND "publishedAt" IS NULL ORDER BY "createdAt" ASC, "id" ASC FOR UPDATE SKIP LOCKED LIMIT $2`,
        [AGENT_TURN_WAKEUP_TOPIC, batchSize],
      )
      if (rows.rows.length === 0) {
        await client.query("COMMIT")
        return processed
      }
      for (const row of rows.rows) {
        const payload = parseWakeup(row.payload)
        if (!payload) throw new Error(`Invalid Agent wakeup outbox payload ${row.id}`)
        await resumeInTransaction(client, payload)
        await client.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = NULL WHERE "id" = $1`, [row.id])
        processed += 1
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

export function startAgentWakeupConsumer(pool: PoolLike = getPool()) {
  const pollMs = Number(process.env.AGENT_WAKEUP_POLL_MS ?? DEFAULT_POLL_MS)
  let closed = false
  let inFlight: Promise<void> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current: Promise<void> = drainAgentWakeups(pool).then(() => undefined).catch((error) => console.error("[agent-wakeup] drain failed:", error)).finally(() => {
      if (inFlight === current) inFlight = null
    })
    inFlight = current
  }
  const timer = setInterval(() => {
    run()
  }, Number.isFinite(pollMs) && pollMs >= 250 && pollMs <= 30_000 ? pollMs : DEFAULT_POLL_MS)
  timer.unref?.()
  run()
  return { async close() { closed = true; clearInterval(timer); await inFlight } }
}
