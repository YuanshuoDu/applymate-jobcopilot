import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { matchesApplyTaskSubmitPayload, type ApplyTaskSubmitIdentity, type ApplyTaskSubmitPayload } from "@jobcopilot/shared"
import { ApplicationSubmitFenceError, withExactAttemptFence, type ApplicationSubmitIdentity } from "./application-submit-fence.js"
import {
  ensureSubmitQueueJob, inspectSubmitDelivery, reconcileClaimedTerminalSubmit,
  resetExpiredSubmitAuthorization, validateCurrentSubmit, type SubmitOutboxIntent as Intent, type SubmitOutboxQueue as SubmitQueue,
} from "./application-submit-outbox-terminal-recovery.js"

export const APPLICATION_SUBMIT_OUTBOX_TOPIC = "application.submit.dispatch"
const DEFAULT_POLL_MS = 1_000
const MAX_BATCH_SIZE = 25
const TERMINAL_ERROR_PREFIX = "terminal:"
type OutboxRow = Readonly<{ id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }>
type ProcessOutcome = "published" | "recovered" | "terminalized" | "skipped"
type StartOptions = { pollMs?: number; drain?: (pool: Pool, queue: SubmitQueue) => Promise<number> }
const pendingCursorByPool = new WeakMap<Pool, string>()
const publishedCursorByPool = new WeakMap<Pool, string>()

function record(value: unknown): Record<string, unknown> | null { const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null }
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value === value.trim() }
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(",") }
function dispatchIds(identity: Pick<ApplyTaskSubmitIdentity, "applicationTaskId" | "fillTurnId" | "receiptId">) { const digest = createHash("sha256").update(JSON.stringify([identity.applicationTaskId, identity.fillTurnId, identity.receiptId])).digest("hex")
  return { workerTaskId: `apply-submit-${digest}`, idempotencyKey: `application-submit:${digest}`, outboxId: `application-submit-outbox-${digest}` }
}
function parseIntent(value: unknown): Intent | null {
  const row = record(value)
  if (!row || !sameKeys(row, ["applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "receiptId", "constraintHash", "workerTaskId", "submitPayload"])) return null
  const { applicationTaskId, userId, jobId, sessionId, fillTurnId, receiptId, constraintHash, workerTaskId } = row
  if (!nonEmptyString(applicationTaskId) || !nonEmptyString(userId) || !nonEmptyString(jobId) ||
    !nonEmptyString(sessionId) || !nonEmptyString(fillTurnId) || !nonEmptyString(receiptId) ||
    !nonEmptyString(workerTaskId) || typeof constraintHash !== "string" || !/^[a-f0-9]{64}$/.test(constraintHash)) return null
  const identity: ApplyTaskSubmitIdentity = { applicationTaskId, userId, jobId, sessionId, fillTurnId, receiptId, constraintHash }
  const submitPayload = record(row.submitPayload)
  if (!submitPayload || !matchesApplyTaskSubmitPayload(submitPayload, identity)) return null
  const expectedKeys = ["applicationTaskId", "jobId", "userId", "applyUrl", "personaId", "resumePath", "operation", "sessionId", "fillTurnId", "receiptId", "constraintHash"]
  if (submitPayload.coverLetterPath !== undefined) expectedKeys.push("coverLetterPath")
  if (submitPayload.dryRun !== undefined) expectedKeys.push("dryRun")
  if (!sameKeys(submitPayload, expectedKeys)) return null
  if (workerTaskId !== dispatchIds(identity).workerTaskId) return null
  return { ...identity, workerTaskId, submitPayload: submitPayload as ApplyTaskSubmitPayload }
}
function asAttempt(intent: Intent): ApplicationSubmitIdentity {
  return { applicationTaskId: intent.applicationTaskId, userId: intent.userId, jobId: intent.jobId,
    sessionId: intent.sessionId, fillTurnId: intent.fillTurnId, approvalId: intent.receiptId, constraintHash: intent.constraintHash }
}
async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> { const client = await pool.connect()
  try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value }
  catch (error: unknown) { await client.query("ROLLBACK").catch(() => undefined); throw error } finally { client.release() }
}
async function selectOutboxRows(pool: Pool, limit: number, published: boolean): Promise<OutboxRow[]> {
  const cursors = published ? publishedCursorByPool : pendingCursorByPool
  const page = (after?: string) => transaction(pool, async client => (await client.query<OutboxRow>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload"
    FROM "agent_outbox" WHERE "topic" = $1 AND "publishedAt" IS ${published ? "NOT " : ""}NULL
      AND ("lastError" IS NULL OR "lastError" NOT LIKE 'terminal:%') AND ($3::text IS NULL OR "id" > $3::text)
    ORDER BY "id" ASC LIMIT $2 ${published ? "" : "FOR UPDATE SKIP LOCKED"}`, [APPLICATION_SUBMIT_OUTBOX_TOPIC, limit, after ?? null])).rows)
  let cursor = cursors.get(pool), rows = await page(cursor)
  if (!rows.length && cursor !== undefined) { cursor = undefined; rows = await page() }
  if (rows.length) cursors.set(pool, rows[rows.length - 1]!.id)
  return rows
}
const selectPending = (pool: Pool, limit: number) => selectOutboxRows(pool, limit, false)
const selectPublished = (pool: Pool, limit: number) => selectOutboxRows(pool, limit, true)
async function lockOutbox(client: PoolClient, id: string, published: boolean): Promise<OutboxRow | undefined> {
  const status = published ? `"publishedAt" IS NOT NULL` : `"publishedAt" IS NULL AND ("lastError" IS NULL OR "lastError" NOT LIKE 'terminal:%')`
  return (await client.query<OutboxRow>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"
    WHERE "id" = $1 AND "topic" = $2 AND ${status} FOR UPDATE`, [id, APPLICATION_SUBMIT_OUTBOX_TOPIC])).rows[0]
}
async function markTerminal(client: PoolClient, row: OutboxRow, reason: string, queue: SubmitQueue, jobId: string | undefined, published: boolean): Promise<boolean> {
  if (await queue.isPaused()) return false
  if (jobId) {
    const [job, lock] = await Promise.all([queue.getJob(jobId), (async () => (await queue.client).get(queue.toKey(`${jobId}:lock`)))()])
    if (lock !== null || (job?.id === jobId && await job.getState() === "active")) return false
  }
  const updated = await client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1, "lastError" = $4
    WHERE "id" = $1 AND "aggregateId" = $2 AND "topic" = $3 AND "publishedAt" IS ${published ? "NOT " : ""}NULL`,
  [row.id, row.aggregateId, APPLICATION_SUBMIT_OUTBOX_TOPIC, `${TERMINAL_ERROR_PREFIX}${reason}`])
  return updated.rowCount === 1
}
function stableJobId(value: unknown): string | undefined {
  const row = record(value)
  if (!row) return undefined
  const { applicationTaskId, fillTurnId, receiptId } = row
  if (nonEmptyString(applicationTaskId) && nonEmptyString(fillTurnId) && nonEmptyString(receiptId)) return dispatchIds({ applicationTaskId, fillTurnId, receiptId }).workerTaskId
  return nonEmptyString(row.workerTaskId) ? row.workerTaskId : undefined
}
async function markPublished(client: PoolClient, row: OutboxRow): Promise<void> {
  const updated = await client.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP,
    "attemptCount" = "attemptCount" + 1, "lastError" = NULL
    WHERE "id" = $1 AND "aggregateId" = $2 AND "topic" = $3 AND "publishedAt" IS NULL`,
  [row.id, row.aggregateId, APPLICATION_SUBMIT_OUTBOX_TOPIC])
  if (updated.rowCount !== 1) throw new Error("application_submit_outbox_ack_missing")
}
async function markRetry(pool: Pool, row: OutboxRow, reason: string): Promise<void> {
  await transaction(pool, async client => client.query(`UPDATE "agent_outbox" SET "attemptCount" = "attemptCount" + 1, "lastError" = $4
    WHERE "id" = $1 AND "aggregateId" = $2 AND "topic" = $3 AND "publishedAt" IS NULL
      AND ("lastError" IS NULL OR "lastError" NOT LIKE 'terminal:%')`, [row.id, row.aggregateId, APPLICATION_SUBMIT_OUTBOX_TOPIC, reason]).then(() => undefined))
}
async function terminalizeClaimed(pool: Pool, queue: SubmitQueue, id: string, intent: Intent, reason: string, published: boolean): Promise<ProcessOutcome> {
  return transaction(pool, async client => {
    const row = await lockOutbox(client, id, published)
    const current = row && parseIntent(row.payload)
    if (!row || !current || current.workerTaskId !== intent.workerTaskId || current.receiptId !== intent.receiptId) return "skipped"
    return await markTerminal(client, row, reason, queue, intent.workerTaskId, published) ? "terminalized" : "skipped"
  })
}
async function processRow(pool: Pool, queue: SubmitQueue, id: string, published = false): Promise<ProcessOutcome> {
  let scanned: OutboxRow | undefined
  let claimedRecovery: Intent | undefined
  try {
    const outcome = await transaction(pool, async client => {
      const marker = published ? `"publishedAt" IS NOT NULL` : `"publishedAt" IS NULL`
      const candidate = await client.query<OutboxRow>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"
        WHERE "id" = $1 AND "topic" = $2 AND ${marker} ORDER BY "id" LIMIT 1`, [id, APPLICATION_SUBMIT_OUTBOX_TOPIC])
      const scannedRow = candidate.rows[0]
      if (!scannedRow) return "skipped"
      scanned = scannedRow
      const intent = parseIntent(scannedRow.payload)
      if (!intent || scannedRow.id !== dispatchIds(intent).outboxId || scannedRow.aggregateId !== intent.sessionId ||
        scannedRow.idempotencyKey !== dispatchIds(intent).idempotencyKey) {
        const row = await lockOutbox(client, id, published)
        if (row && await markTerminal(client, row, intent ? "outbox_identity_mismatch" : "invalid_intent_payload",
          queue, stableJobId(row.payload), published)) return "terminalized"
        return "skipped"
      }
      await client.query("SELECT set_config($1, $2, true)", ["app.user_id", intent.userId])
      let fenced
      try {
        fenced = await withExactAttemptFence(client, asAttempt(intent), async () => {
          const row = await lockOutbox(client, id, published)
          if (!row) return "skipped" as const
          const currentIntent = parseIntent(row.payload)
          if (!currentIntent || currentIntent.workerTaskId !== intent.workerTaskId || currentIntent.receiptId !== intent.receiptId ||
            currentIntent.fillTurnId !== intent.fillTurnId || currentIntent.applicationTaskId !== intent.applicationTaskId ||
            row.aggregateId !== intent.sessionId || row.idempotencyKey !== dispatchIds(intent).idempotencyKey) {
            const terminalized = await markTerminal(client, row, "outbox_identity_changed", queue, stableJobId(row.payload), published)
            return terminalized ? "terminalized" as const : "skipped" as const
          }
          const reason = row.id !== dispatchIds(currentIntent).outboxId || row.aggregateId !== currentIntent.sessionId ||
            row.idempotencyKey !== dispatchIds(currentIntent).idempotencyKey ? "outbox_identity_mismatch"
            : await validateCurrentSubmit(client, currentIntent)
          if (reason === "claimed_delivery_recovery") {
            const delivery = await inspectSubmitDelivery(queue, currentIntent, false)
            if (delivery === "terminal") { claimedRecovery = currentIntent; return "skipped" as const }
            if (delivery === "missing") {
              const terminalized = await markTerminal(client, row, "claimed_delivery_missing", queue, currentIntent.workerTaskId, published)
              return terminalized ? "terminalized" as const : "skipped" as const
            }
            if (delivery === "mismatch") {
              const terminalized = await markTerminal(client, row, "queue_job_identity_mismatch", queue, currentIntent.workerTaskId, published)
              return terminalized ? "terminalized" as const : "skipped" as const
            }
            return "skipped" as const
          }
          if (reason === "approval_expired") {
            const delivery = await inspectSubmitDelivery(queue, currentIntent, true)
            if (delivery === "mismatch") {
              const terminalized = await markTerminal(client, row, "queue_job_identity_mismatch", queue, currentIntent.workerTaskId, published)
              return terminalized ? "terminalized" as const : "skipped" as const
            }
            if (delivery !== "absent" && delivery !== "terminal") return "skipped" as const
            if (!await markTerminal(client, row, reason, queue, currentIntent.workerTaskId, published)) return "skipped" as const
            await resetExpiredSubmitAuthorization(client, currentIntent)
            return "terminalized" as const
          }
          if (reason) {
            const terminalized = await markTerminal(client, row, reason, queue, currentIntent.workerTaskId, published)
            return terminalized ? "terminalized" as const : "skipped" as const
          }
          const confirmation = await ensureSubmitQueueJob(queue, currentIntent)
          if (confirmation === "mismatch") {
            const terminalized = await markTerminal(client, row, "queue_job_identity_mismatch", queue, currentIntent.workerTaskId, published)
            return terminalized ? "terminalized" as const : "skipped" as const
          }
          if (confirmation === "deferred") return "skipped" as const
          if (!published) await markPublished(client, row)
          return published ? "recovered" as const : "published" as const
        })
      } catch (error: unknown) {
        if (!(error instanceof ApplicationSubmitFenceError)) throw error
        const row = await lockOutbox(client, id, published)
        if (row && await markTerminal(client, row, error.code, queue, stableJobId(row.payload), published)) return "terminalized"
        return "skipped"
      }
      if (fenced.kind === "superseded") {
        const row = await lockOutbox(client, id, published)
        if (row && await markTerminal(client, row, "attempt_superseded", queue, stableJobId(row.payload), published)) return "terminalized"
        return "skipped"
      }
      return fenced.value
    })
    if (claimedRecovery) {
      const recovery = await reconcileClaimedTerminalSubmit(pool, queue, claimedRecovery)
      if (recovery === "reconciled") return terminalizeClaimed(pool, queue, id, claimedRecovery, "terminal_submit_reconciled", published)
      if (recovery === "mismatch") return terminalizeClaimed(pool, queue, id, claimedRecovery, "queue_job_identity_mismatch", published)
      return "skipped"
    }
    return outcome
  } catch (error: unknown) {
    if (scanned && !published) await markRetry(pool, scanned, "queue_delivery_or_ack_failed").catch(() => undefined)
    throw error
  }
}
export async function drainApplicationSubmitOutbox(pool: Pool, queue: SubmitQueue, limit = MAX_BATCH_SIZE): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Application submit outbox batch size must be positive")
  if (await queue.isPaused()) return 0
  const bounded = Math.min(limit, MAX_BATCH_SIZE)
  const rows = await selectPending(pool, bounded), publishedRows = await selectPublished(pool, bounded)
  let recoveredCount = 0
  let firstError: unknown
  for (const [batch, isPublished] of [[rows, false], [publishedRows, true]] as const) for (const row of batch) {
    try { const outcome = await processRow(pool, queue, row.id, isPublished); if (outcome === "published" || outcome === "recovered") recoveredCount++ }
    catch (error: unknown) { firstError ??= error }
  }
  if (firstError) throw firstError
  return recoveredCount
}
export function startApplicationSubmitOutboxPublisher(pool: Pool, queue: SubmitQueue, options: StartOptions = {}) {
  const configured = Number(options.pollMs ?? process.env.APPLICATION_SUBMIT_OUTBOX_POLL_MS ?? DEFAULT_POLL_MS)
  const pollMs = Number.isInteger(configured) && configured >= 250 && configured <= 30_000 ? configured : DEFAULT_POLL_MS
  const drain = options.drain ?? drainApplicationSubmitOutbox
  let closed = false
  let inFlight: Promise<void> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = drain(pool, queue).catch(error => { console.error("[application-submit-outbox] drain failed:", error) })
      .then(() => undefined).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, pollMs)
  timer.unref?.()
  run()
  return { async close() { closed = true; clearInterval(timer); await inFlight } }
}
