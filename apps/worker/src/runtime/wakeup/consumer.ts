import { randomUUID } from "node:crypto"
import type pg from "pg"
import { getPool } from "../../db/apply-results.js"
import { persistWakeupTurnDispatchInTransaction } from "../turns/recovery-scanner.js"
import { AGENT_TURN_WAKEUP_TOPIC, parseWakeup, type AgentTurnWakeupPayload, type WakeupResult } from "./types.js"
type Client = pg.PoolClient
type PoolLike = Pick<pg.Pool, "connect">
interface OutboxRow { id: string; aggregateId: string; payload: unknown; publishedAt?: Date | string | null }
interface WakeupEventRow { sessionId: string; turnId: string; itemId: string | null; type: string; payload: unknown }
type TerminalWakeupErrorCode = "schema_invalid_payload" | "outbox_scope_mismatch" | "event_lineage_mismatch" | "item_lineage_mismatch" | "tool_lineage_mismatch" | "turn_revision_conflict" | "wait_scope_mismatch"
class TerminalWakeupError extends Error { constructor(readonly code: TerminalWakeupErrorCode, message: string) { super(message); this.name = "TerminalWakeupError" } }
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_POLL_MS = 1_000
const CLOSED_SESSION_STATUSES = new Set(["aborted", "archived"])
function json(value: unknown): string { return JSON.stringify(value) }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function validateWakeupPayload(payload: AgentTurnWakeupPayload): void {
  const identifiers = [payload.eventId, payload.sessionId, payload.turnId, payload.itemId, payload.waitId]
  const validToolCallId = payload.toolCallId === null || (typeof payload.toolCallId === "string" && payload.toolCallId.trim().length > 0)
  if (!identifiers.every((value) => typeof value === "string" && value.trim().length > 0) || (payload.waitKind !== "approval" && payload.waitKind !== "question") || (payload.status !== "approved" && payload.status !== "rejected" && payload.status !== "answered") || !validToolCallId || !Number.isSafeInteger(payload.nextTurnRevision) || payload.nextTurnRevision < 0) throw new TerminalWakeupError("schema_invalid_payload", "Agent wakeup payload is invalid")
}
async function assertWakeupEvent(client: Client, payload: AgentTurnWakeupPayload): Promise<void> {
  const result = await client.query<WakeupEventRow>(`SELECT "sessionId", "turnId", "itemId", "type", "payload" FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "itemId" = $4 AND "type" = 'turn.wakeup' FOR SHARE`, [payload.eventId, payload.sessionId, payload.turnId, payload.itemId])
  const event = result.rows[0]
  const eventPayload = record(event?.payload)
  if (!event || event.itemId !== payload.itemId || event.type !== "turn.wakeup" || eventPayload.waitKind !== payload.waitKind || eventPayload.waitId !== payload.waitId || eventPayload.itemId !== payload.itemId || eventPayload.turnId !== payload.turnId || eventPayload.toolCallId !== payload.toolCallId || eventPayload.status !== payload.status || eventPayload.nextTurnRevision !== payload.nextTurnRevision) {
    throw new TerminalWakeupError("event_lineage_mismatch", "Agent wakeup event lineage does not match payload")
  }
}
async function appendResumeEvent(client: Client, payload: AgentTurnWakeupPayload, userId: string): Promise<void> {
  const sequenceResult = await client.query<{ eventSequence: string | bigint }>(
    `UPDATE "agent_sessions" AS session
     SET "eventSequence" = "eventSequence" + 1
     WHERE session."id" = $1 AND session."userId" = $2
       AND session."status" NOT IN ('aborted', 'archived')
     RETURNING "eventSequence"`,
    [payload.sessionId, userId],
  )
  const sequence = sequenceResult.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("Agent session sequence is unavailable for wakeup")
  const eventId = randomUUID()
  const eventPayload = { waitKind: payload.waitKind, waitId: payload.waitId, itemId: payload.itemId, turnId: payload.turnId, toolCallId: payload.toolCallId, status: payload.status, resumedFromEventId: payload.eventId }
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, NULL, $5, 'turn.resumed', 'system', $3, $6, $7, $8::jsonb)`, [eventId, payload.sessionId, payload.turnId, payload.itemId, String(sequence), payload.eventId, `agent-wakeup:${payload.eventId}:resumed`, json(eventPayload)])
  await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.session.event', $2, $3, $4::jsonb)`, [`agent-outbox-${eventId}`, payload.sessionId, `agent-event:${eventId}`, json({
      eventId, sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId,
      taskId: null, sequence: String(sequence), type: "turn.resumed", actor: "system",
      correlationId: payload.turnId, causationId: payload.eventId, idempotencyKey: `agent-wakeup:${payload.eventId}:resumed`, payload: eventPayload,
    })])
}
async function resumeInTransaction(client: Client, payload: AgentTurnWakeupPayload): Promise<WakeupResult> {
  validateWakeupPayload(payload)
  const sessionResult = await client.query<{ userId: string; status: string }>(
    `SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`,
    [payload.sessionId],
  )
  const session = sessionResult.rows[0]
  if (!session || CLOSED_SESSION_STATUSES.has(session.status)) {
    return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  }
  await client.query(`SELECT set_config($1, $2, true)`, ["app.user_id", session.userId])
  const turnResult = await client.query<{ userId: string; status: string; revision: number }>(
    `SELECT turn."userId", turn."status", turn."revision" FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 FOR UPDATE`,
    [payload.turnId, payload.sessionId, session.userId],
  )
  const turn = turnResult.rows[0]
  if (!turn) return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await assertWakeupEvent(client, payload)
  if (turn.status === "queued" || turn.status === "in_progress") {
    return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  }
  if (turn.status !== "waiting_for_approval" && turn.status !== "waiting_for_user") {
    return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  }
  const expectedTurnStatus = payload.waitKind === "approval" ? "waiting_for_approval" : "waiting_for_user"
  if (turn.status !== expectedTurnStatus) throw new TerminalWakeupError("wait_scope_mismatch", "Agent wakeup wait kind does not match Turn status")
  if (turn.revision !== payload.nextTurnRevision) {
    throw new TerminalWakeupError("turn_revision_conflict", "Agent Turn revision changed before wakeup")
  }
  const itemResult = await client.query<{ status: string; content: unknown }>(
    `SELECT "status", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = $4 FOR UPDATE`,
    [payload.itemId, payload.sessionId, payload.turnId, payload.waitKind === "approval" ? "approval_request" : "question"],
  )
  const item = itemResult.rows[0]
  if (!item || item.status !== "completed") return { status: "ignored", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  const content = item.content && typeof item.content === "object" && !Array.isArray(item.content) ? item.content as Record<string, unknown> : {}
  const itemWaitId = payload.waitKind === "approval"
    ? content.approvalId
    : content.oauth === true ? content.waitId : content.questionId
  if (content.waitKind !== payload.waitKind || itemWaitId !== payload.waitId) throw new TerminalWakeupError("item_lineage_mismatch", "Agent wait item lineage does not match wakeup")
  const itemToolCallId = typeof content.toolCallId === "string" ? content.toolCallId : null
  if (itemToolCallId !== payload.toolCallId) throw new TerminalWakeupError("tool_lineage_mismatch", "Agent wait tool lineage does not match wakeup")

  const updated = await client.query(
    `UPDATE "agent_turns" AS turn
     SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
         "leaseStartedAt" = NULL, "revision" = "revision" + 1,
         "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
       AND turn."status" IN ('waiting_for_approval', 'waiting_for_user') AND turn."revision" = $4
       AND EXISTS (
         SELECT 1 FROM "agent_sessions" AS session
         WHERE session."id" = turn."sessionId" AND session."userId" = turn."userId"
           AND session."status" NOT IN ('aborted', 'archived')
       )`,
    [payload.turnId, payload.sessionId, session.userId, payload.nextTurnRevision],
  )
  if (updated.rowCount !== 1) return { status: "already_resumed", sessionId: payload.sessionId, turnId: payload.turnId, itemId: payload.itemId, toolCallId: payload.toolCallId }
  await client.query(
    `UPDATE "agent_executions"
     SET "status" = 'queued', "error" = NULL, "completedAt" = NULL
     WHERE "userId" = $1 AND "sessionId" = $2 AND "status" = 'waiting_for_user'`,
    [session.userId, payload.sessionId],
  )
  await appendResumeEvent(client, payload, session.userId)
  if (!await persistWakeupTurnDispatchInTransaction(client, payload.turnId, payload.sessionId, payload.eventId)) throw new TerminalWakeupError("outbox_scope_mismatch", "Turn dispatch lineage does not match wakeup scope")
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
async function withTransaction<T>(pool: PoolLike, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
async function selectPendingWakeups(pool: PoolLike, batchSize: number): Promise<OutboxRow[]> {
  return withTransaction(pool, async (client) => (await client.query<OutboxRow>(`SELECT "id", "aggregateId", "payload" FROM "agent_outbox" WHERE "topic" = $1 AND "publishedAt" IS NULL ORDER BY "createdAt" ASC, "id" ASC LIMIT $2 FOR UPDATE SKIP LOCKED`, [AGENT_TURN_WAKEUP_TOPIC, batchSize])).rows)
}
async function markWakeupPublished(client: Client, rowId: string, lastError: string | null): Promise<void> {
  await client.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1, "lastError" = $3 WHERE "id" = $1 AND "topic" = $2 AND "publishedAt" IS NULL`, [rowId, AGENT_TURN_WAKEUP_TOPIC, lastError])
}
async function markWakeupAttemptFailed(client: Client, rowId: string): Promise<void> {
  await client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1, "lastError" = $3 WHERE "id" = $1 AND "topic" = $2 AND "publishedAt" IS NULL`, [rowId, AGENT_TURN_WAKEUP_TOPIC, "processing_error"])
}
type RowOutcome = "published" | "retry" | "skipped"
async function processWakeupRow(pool: PoolLike, row: OutboxRow): Promise<RowOutcome> {
  const client = await pool.connect()
  let transactionOpen = false
  try {
    await client.query("BEGIN")
    transactionOpen = true
    const currentResult = await client.query<OutboxRow>(
      `SELECT "id", "aggregateId", "payload", "publishedAt"
       FROM "agent_outbox"
       WHERE "id" = $1 AND "topic" = $2
       FOR UPDATE`,
      [row.id, AGENT_TURN_WAKEUP_TOPIC],
    )
    const current = currentResult.rows[0]
    if (!current || current.publishedAt !== null) {
      await client.query("COMMIT")
      transactionOpen = false
      return "skipped"
    }

    const payload = parseWakeup(current.payload)
    if (!payload) {
      await markWakeupPublished(client, current.id, "schema_invalid_payload")
      await client.query("COMMIT")
      transactionOpen = false
      return "published"
    }
    if (current.aggregateId !== payload.sessionId) {
      await markWakeupPublished(client, current.id, "outbox_scope_mismatch")
      await client.query("COMMIT")
      transactionOpen = false
      return "published"
    }

    try {
      await resumeInTransaction(client, payload)
      await markWakeupPublished(client, current.id, null)
      await client.query("COMMIT")
      transactionOpen = false
      return "published"
    } catch (error) {
      if (error instanceof TerminalWakeupError) {
        await markWakeupPublished(client, current.id, error.code)
        await client.query("COMMIT")
        transactionOpen = false
        return "published"
      }
      await client.query("ROLLBACK").catch(() => undefined)
      transactionOpen = false
      await markWakeupAttemptFailed(client, current.id).catch(() => undefined)
      return "retry"
    }
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
    await markWakeupAttemptFailed(client, row.id).catch(() => undefined)
    return "retry"
  } finally {
    client.release()
  }
}
export async function drainAgentWakeups(pool: PoolLike, batchSize = DEFAULT_BATCH_SIZE): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError("Wakeup batch size must be positive")
  let processed = 0
  for (;;) {
    const rows = await selectPendingWakeups(pool, batchSize)
    if (rows.length === 0) return processed
    let retryPending = false
    for (const row of rows) {
      const outcome = await processWakeupRow(pool, row)
      if (outcome === "published") processed += 1
      if (outcome === "retry") retryPending = true
    }
    if (retryPending) return processed
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
