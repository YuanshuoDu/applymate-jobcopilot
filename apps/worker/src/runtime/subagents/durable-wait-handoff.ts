import { randomUUID } from "node:crypto"

import type pg from "pg"

import { TurnLeaseError, type LeasePool, type TurnLease } from "../turns/lease.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

const DISPATCH_TOPIC = "agent.turn.dispatch"

export type DurableWaitHandoffInput = {
  readonly lease: TurnLease
  readonly waitId: string
  readonly now?: Date
}

export type DurableWaitHandoffResult = {
  readonly waitId: string
  readonly handoff: "suspended" | "queued"
  readonly waitStatus: "waiting" | "ready" | "timed_out"
  readonly idempotent: boolean
}

export class DurableWaitHandoffError extends Error {
  constructor(readonly code: "wait_invalid" | "wait_scope_error", message: string) {
    super(message)
    this.name = "DurableWaitHandoffError"
  }
}

function required(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new DurableWaitHandoffError("wait_invalid", `${name} is required`)
  return value
}

function valueDate(value: unknown, name: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) throw new DurableWaitHandoffError("wait_scope_error", `${name} is invalid`)
  return parsed
}

function failLease(message: string): never {
  throw new TurnLeaseError("lease_lost", message)
}

function scope(row: Row | undefined, message: string): Row {
  if (!row) throw new DurableWaitHandoffError("wait_scope_error", message)
  return row
}

async function transaction<T>(pool: LeasePool, userId: string, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await work(client)
    await client.query("COMMIT")
    committed = true
    return result
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function dispatchKey(turnId: string): string { return `turn-dispatch:${turnId}` }

async function enqueueDispatch(client: Queryable, input: DurableWaitHandoffInput, turnId: string, sessionId: string, resetPublished = true): Promise<void> {
  if (!resetPublished) {
    const existing = await client.query<Row>(
      `SELECT "id" FROM "agent_outbox" WHERE "topic" = $1 AND "idempotencyKey" = $2 FOR UPDATE`,
      [DISPATCH_TOPIC, dispatchKey(turnId)],
    )
    if (existing.rows[0]) return
  }
  const payload = JSON.stringify({ turnId, sessionId, ownerId: input.lease.ownerId })
  await client.query(
    `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
     VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO UPDATE
       SET "payload" = EXCLUDED."payload", "publishedAt" = NULL, "lastError" = NULL,
           "attemptCount" = "agent_outbox"."attemptCount" + 1`,
    [randomUUID(), DISPATCH_TOPIC, turnId, dispatchKey(turnId), payload],
  )
}

function dateValue(row: Row, key: string): Date | null {
  return row[key] === null || row[key] === undefined ? null : valueDate(row[key], key)
}

/** Atomically hands a dependency wait from an owned in-progress Turn to durable state. */
export async function suspendAndReleaseWait(pool: LeasePool, input: DurableWaitHandoffInput): Promise<DurableWaitHandoffResult> {
  const lease = input.lease
  required(input.waitId, "waitId")
  const now = input.now ?? new Date()
  return transaction(pool, lease.userId, async client => {
    const turn = scope((await client.query<Row>(
      `SELECT turn."id", turn."userId", turn."sessionId", turn."rootTaskId", turn."status",
              turn."leaseOwnerId", turn."leaseVersion", turn."leaseExpiresAt", turn."leaseStartedAt"
       FROM "agent_turns" AS turn
       WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 FOR UPDATE`,
      [lease.turnId, lease.sessionId, lease.userId],
    )).rows[0], "Turn is unavailable")
    const wait = scope((await client.query<Row>(
      `SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "status",
              "deadlineAt", "matchedTaskIds", "suspendedAt"
       FROM "agent_wait_conditions"
       WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4 FOR UPDATE`,
      [input.waitId, lease.userId, lease.sessionId, lease.turnId],
    )).rows[0], "Wait condition is unavailable")
    if (String(turn.id) !== lease.turnId || String(turn.userId) !== lease.userId || String(turn.sessionId) !== lease.sessionId) {
      throw new DurableWaitHandoffError("wait_scope_error", "Turn is outside the wait scope")
    }
    const rootTaskId = typeof turn.rootTaskId === "string" && turn.rootTaskId ? turn.rootTaskId : null
    if (!rootTaskId || String(wait.parentTaskId) !== rootTaskId || String(wait.userId) !== lease.userId
      || String(wait.sessionId) !== lease.sessionId || String(wait.turnId) !== lease.turnId) {
      throw new DurableWaitHandoffError("wait_scope_error", "Wait parent is outside the root Turn scope")
    }
    const step = scope((await client.query<Row>(
      `SELECT "id", "taskId", "attempt", "status"
       FROM "agent_steps"
       WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3
         AND ("taskId" = $4 OR "taskId" IS NULL) FOR SHARE`,
      [wait.stepId, lease.turnId, lease.sessionId, rootTaskId],
    )).rows[0], "Wait step is outside the root Turn scope")
    if (String(step.status) !== "waiting_for_tool" || Number(step.attempt) !== 1) {
      throw new DurableWaitHandoffError("wait_scope_error", "Wait step is not the current attempt")
    }
    const waitStatus = String(wait.status)
    const turnStatus = String(turn.status)
    const ownerCleared = turn.leaseOwnerId === null || turn.leaseOwnerId === undefined
    const expiry = dateValue(turn, "leaseExpiresAt")
    const alreadySuspended = waitStatus === "waiting" && wait.suspendedAt !== null && wait.suspendedAt !== undefined
      && turnStatus === "waiting_for_dependency" && ownerCleared
    if (alreadySuspended) return { waitId: String(wait.id), handoff: "suspended", waitStatus: "waiting", idempotent: true }
    const alreadyQueued = (waitStatus === "ready" || waitStatus === "timed_out") && turnStatus === "queued" && ownerCleared
    if (alreadyQueued) {
      await enqueueDispatch(client, input, lease.turnId, lease.sessionId, false)
      return { waitId: String(wait.id), handoff: "queued", waitStatus: waitStatus as "ready" | "timed_out", idempotent: true }
    }
    if (waitStatus !== "waiting" && waitStatus !== "ready" && waitStatus !== "timed_out") {
      throw new DurableWaitHandoffError("wait_scope_error", "Wait condition is already closed")
    }
    const leaseMatches = String(turn.leaseOwnerId) === lease.ownerId && Number(turn.leaseVersion) === lease.leaseVersion
      && expiry !== null && expiry.getTime() > now.getTime() && turnStatus === "in_progress"
    if (!leaseMatches) failLease("Turn lease was fenced before wait handoff")
    if (waitStatus === "waiting") {
      const suspended = await client.query(
        `UPDATE "agent_wait_conditions" SET "suspendedAt" = COALESCE("suspendedAt", $2), "updatedAt" = $2
         WHERE "id" = $1 AND "userId" = $3 AND "sessionId" = $4 AND "status" = 'waiting'`,
        [input.waitId, now, lease.userId, lease.sessionId],
      )
      if (suspended.rowCount !== 1) throw new DurableWaitHandoffError("wait_scope_error", "Wait changed during handoff")
      const released = await client.query(
        `UPDATE "agent_turns" SET "status" = 'waiting_for_dependency', "leaseOwnerId" = NULL,
           "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "revision" = "revision" + 1,
           "completedAt" = NULL, "updatedAt" = $5
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $6 AND "leaseOwnerId" = $3
           AND "leaseVersion" = $4 AND "status" = 'in_progress' AND "leaseExpiresAt" > $5`,
        [lease.turnId, lease.sessionId, lease.ownerId, lease.leaseVersion, now, lease.userId],
      )
      if (released.rowCount !== 1) failLease("Turn lease was fenced during wait handoff")
      return { waitId: String(wait.id), handoff: "suspended", waitStatus: "waiting", idempotent: false }
    }
    await client.query(
      `UPDATE "agent_wait_conditions" SET "suspendedAt" = COALESCE("suspendedAt", $2), "updatedAt" = $2
       WHERE "id" = $1 AND "userId" = $3 AND "sessionId" = $4 AND "status" IN ('ready', 'timed_out') AND "consumedAt" IS NULL`,
      [input.waitId, now, lease.userId, lease.sessionId],
    )
    const queued = await client.query(
      `UPDATE "agent_turns" SET "status" = 'queued', "leaseOwnerId" = NULL,
         "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "revision" = "revision" + 1,
         "completedAt" = NULL, "updatedAt" = $5
       WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $6 AND "leaseOwnerId" = $3
         AND "leaseVersion" = $4 AND "status" = 'in_progress' AND "leaseExpiresAt" > $5`,
      [lease.turnId, lease.sessionId, lease.ownerId, lease.leaseVersion, now, lease.userId],
    )
    if (queued.rowCount !== 1) failLease("Turn lease was fenced during wait requeue")
    await enqueueDispatch(client, input, lease.turnId, lease.sessionId)
    return { waitId: String(wait.id), handoff: "queued", waitStatus: waitStatus as "ready" | "timed_out", idempotent: false }
  })
}
