import { randomUUID } from "node:crypto"

import type pg from "pg"

import type { LeasePool } from "../turns/lease.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

const DEFAULT_BATCH_SIZE = 25
const DEFAULT_POLL_MS = 5_000
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
const DISPATCH_TOPIC = "agent.turn.dispatch"

export type DurableWaitReconcileOptions = {
  readonly batchSize?: number
  readonly now?: Date
  readonly ownerId?: string
}
export type DurableWaitReconcileReport = { readonly scanned: number; readonly resolved: number; readonly woken: number }
export type DurableWaitResolverOptions = DurableWaitReconcileOptions & { readonly intervalMs?: number }

function ids(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return [] } })() : value
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : []
}
function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed : null
}
function json(value: unknown): string { return JSON.stringify(value) }
function dispatchKey(turnId: string): string { return `turn-dispatch:${turnId}` }
function validBatch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new RangeError("Wait resolver batch size must be between 1 and 100")
  return value
}
function terminal(value: unknown): boolean { return TERMINAL_TASK_STATUSES.has(String(value)) }

async function transaction<T>(pool: LeasePool, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN")
    const value = await work(client)
    await client.query("COMMIT"); committed = true
    return value
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function writeDispatch(client: Queryable, row: Row, ownerId: string): Promise<void> {
  const turnId = String(row.id); const sessionId = String(row.sessionId)
  await client.query(
    `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
     VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO UPDATE
       SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL,
           "attemptCount" = "agent_outbox"."attemptCount" + 1`,
    [randomUUID(), DISPATCH_TOPIC, turnId, dispatchKey(turnId), json({ turnId, sessionId, ownerId })],
  )
}

async function reconcileWait(client: Queryable, wait: Row, turn: Row, now: Date, ownerId: string): Promise<"resolved" | "woken" | "ignored"> {
  const rootTaskId = typeof turn.rootTaskId === "string" ? turn.rootTaskId : ""
  const parent = (await client.query<Row>(
    `SELECT task."id", task."rootTaskId", task."turnId", task."sessionId", session."userId" AS "userId"
     FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
     WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
       AND session."userId" = $4 FOR SHARE`,
    [wait.parentTaskId, turn.sessionId, turn.id, turn.userId],
  )).rows[0]
  if (!parent || String(parent.rootTaskId ?? parent.id) !== rootTaskId || String(parent.id) !== rootTaskId) return "ignored"
  const step = (await client.query<Row>(
    `SELECT "id", "taskId", "attempt", "status" FROM "agent_steps"
     WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3
       AND ("taskId" = $4 OR "taskId" IS NULL) FOR SHARE`,
    [wait.stepId, turn.id, turn.sessionId, rootTaskId],
  )).rows[0]
  if (!step || String(step.status) !== "waiting_for_tool" || Number(step.attempt) !== 1) return "ignored"
  const targetIds = ids(wait.targetTaskIds)
  if (targetIds.length === 0) return "ignored"
  const targets = await client.query<Row>(
    `SELECT task."id", task."rootTaskId", task."turnId", task."sessionId", task."status", session."userId" AS "userId"
     FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
     WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
       AND session."userId" = $4`,
    [targetIds, turn.sessionId, turn.id, turn.userId],
  )
  if (targets.rows.length !== targetIds.length || targets.rows.some(target => String(target.rootTaskId ?? target.id) !== rootTaskId || String(target.id) === rootTaskId)) return "ignored"
  const waitStatus = String(wait.status)
  const deadline = date(wait.deadlineAt)
  const matched = targets.rows.filter(target => terminal(target.status)).map(target => String(target.id)).sort()
  const resolvedStatus = deadline && now >= deadline ? "timed_out" : String(wait.mode) === "any" && matched.length > 0 ? "ready" : String(wait.mode) === "all" && matched.length === targetIds.length ? "ready" : "waiting"
  let changed = false
  if (waitStatus === "waiting" && resolvedStatus !== "waiting") {
    const updated = await client.query(
      `UPDATE "agent_wait_conditions" SET "status" = $1, "matchedTaskIds" = $2::jsonb,
         "resolvedAt" = COALESCE("resolvedAt", $3), "updatedAt" = $3
       WHERE "id" = $4 AND "userId" = $5 AND "sessionId" = $6 AND "status" = 'waiting' AND "consumedAt" IS NULL`,
      [resolvedStatus, json(matched), now, wait.id, turn.userId, turn.sessionId],
    )
    changed = updated.rowCount === 1
  }
  const finalStatus = waitStatus === "waiting" ? resolvedStatus : waitStatus
  if (!changed && finalStatus === "waiting") return "ignored"
  if (wait.suspendedAt === null || wait.suspendedAt === undefined || String(turn.status) !== "waiting_for_dependency") return changed ? "resolved" : "ignored"
  if (turn.leaseOwnerId !== null && turn.leaseOwnerId !== undefined) return changed ? "resolved" : "ignored"
  const queued = await client.query(
    `UPDATE "agent_turns" SET "status" = 'queued', "leaseOwnerId" = NULL,
       "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "revision" = "revision" + 1,
       "completedAt" = NULL, "updatedAt" = $3
     WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'waiting_for_dependency'
       AND "rootTaskId" = $4 AND "leaseOwnerId" IS NULL`,
    [turn.id, turn.sessionId, now, rootTaskId],
  )
  if (queued.rowCount !== 1) return changed ? "resolved" : "ignored"
  await writeDispatch(client, turn, ownerId)
  return "woken"
}

/** Reconciles a bounded set of active Turns and wakes only suspended parents. */
export async function reconcileDurableWaits(pool: LeasePool, options: DurableWaitReconcileOptions = {}): Promise<DurableWaitReconcileReport> {
  const batchSize = validBatch(options.batchSize ?? DEFAULT_BATCH_SIZE); const now = options.now ?? new Date(); const ownerId = options.ownerId ?? "wait-resolver"
  return transaction(pool, async client => {
    const turns = await client.query<Row>(
      `SELECT turn."id", turn."userId", turn."sessionId", turn."rootTaskId", turn."status", turn."leaseOwnerId"
       FROM "agent_turns" AS turn
       WHERE turn."status" IN ('waiting_for_dependency', 'in_progress') AND turn."rootTaskId" IS NOT NULL
       ORDER BY turn."updatedAt" ASC, turn."id" ASC FOR UPDATE SKIP LOCKED LIMIT $1`,
      [batchSize],
    )
    let scanned = 0; let resolved = 0; let woken = 0
    for (const turn of turns.rows) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [String(turn.userId)])
      const waits = await client.query<Row>(
        `SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "targetTaskIds", "mode", "status", "deadlineAt", "suspendedAt", "consumedAt"
         FROM "agent_wait_conditions" WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3
           AND "status" IN ('waiting', 'ready', 'timed_out') AND "consumedAt" IS NULL
         ORDER BY "createdAt" ASC, "id" ASC FOR UPDATE SKIP LOCKED LIMIT $4`,
        [turn.userId, turn.sessionId, turn.id, Math.max(0, batchSize - scanned)],
      )
      for (const wait of waits.rows) {
        scanned += 1
        const outcome = await reconcileWait(client, wait, turn, now, ownerId)
        if (outcome === "resolved" || outcome === "woken") resolved += 1
        if (outcome === "woken") woken += 1
        if (scanned >= batchSize) break
      }
      if (scanned >= batchSize) break
    }
    return { scanned, resolved, woken }
  })
}

export function startDurableWaitResolver(pool: LeasePool, options: DurableWaitResolverOptions = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError("Wait resolver interval must be positive")
  validBatch(options.batchSize ?? DEFAULT_BATCH_SIZE)
  let closed = false; let inFlight: Promise<unknown> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = reconcileDurableWaits(pool, options).catch(error => { console.error("[wait-resolver] scan failed:", error) }).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, intervalMs); timer.unref?.(); run()
  return { async close() { closed = true; clearInterval(timer); await inFlight } }
}
