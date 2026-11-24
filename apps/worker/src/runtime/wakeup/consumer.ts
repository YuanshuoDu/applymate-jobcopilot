import type pg from "pg"
import { getPool } from "../../db/apply-results.js"
import { AGENT_TURN_WAKEUP_TOPIC, parseWakeup } from "./types.js"
import { resumeAgentTurn, resumeAgentTurnInTransaction, TerminalWakeupError } from "./resume-agent-turn-transaction.js"
export { resumeAgentTurn } from "./resume-agent-turn-transaction.js"
type Client = pg.PoolClient
type PoolLike = Pick<pg.Pool, "connect">
interface OutboxRow { id: string; aggregateId: string; payload: unknown; publishedAt?: Date | string | null }
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_POLL_MS = 1_000
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
type RowOutcome = "published" | "deferred" | "retry" | "skipped"
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
      const result = await resumeAgentTurnInTransaction(client, payload)
      if (result.status === "deferred") {
        await client.query("COMMIT")
        transactionOpen = false
        return "deferred"
      }
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
    let deferredPending = false
    for (const row of rows) {
      const outcome = await processWakeupRow(pool, row)
      if (outcome === "published") processed += 1
      if (outcome === "deferred") deferredPending = true
      if (outcome === "retry") retryPending = true
    }
    if (retryPending || deferredPending) return processed
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
