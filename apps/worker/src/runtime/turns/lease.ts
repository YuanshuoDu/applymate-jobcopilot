import type pg from "pg"

/** Normal owner window. A scanner reclaims the Turn after this expires. */
export const TURN_LEASE_WINDOW_MS = 60_000
/** Renew before the 60s window expires, while the owner is still healthy. */
export const TURN_HEARTBEAT_INTERVAL_MS = 20_000
/** Maximum continuous ownership; heartbeat renewal cannot extend beyond it. */
export const TURN_MAX_LEASE_MS = 5 * 60_000

export type TurnJobPayload = {
  turnId: string
  sessionId: string
  ownerId: string
}
export function parseTurnJobPayload(value: unknown): TurnJobPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).sort().join(",")
  if (keys !== "ownerId,sessionId,turnId") return null
  if (![row.turnId, row.sessionId, row.ownerId].every((entry) => typeof entry === "string" && entry.trim().length > 0)) return null
  return { turnId: row.turnId as string, sessionId: row.sessionId as string, ownerId: row.ownerId as string }
}

export type TurnLease = TurnJobPayload & {
  userId: string
  leaseVersion: number
  leaseStartedAt: Date
  leaseExpiresAt: Date
}

export type LeasePool = Pick<pg.Pool, "connect">
export type LeaseReleaseStatus =
  | "queued"
  | "waiting_for_dependency"
  | "waiting_for_approval"
  | "waiting_for_user"
  | "interrupted"
  | "failed"
  | "completed"

export type LeaseErrorCode = "lease_not_available" | "lease_lost"

export class TurnLeaseError extends Error {
  readonly recoverable = true

  constructor(readonly code: LeaseErrorCode, message: string) {
    super(message)
    this.name = "TurnLeaseError"
  }
}

type LeaseRow = {
  id: string
  sessionId: string
  userId: string
  leaseOwnerId: string
  leaseVersion: number
  leaseStartedAt: Date | string
  leaseExpiresAt: Date | string
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function lease(row: LeaseRow): TurnLease {
  return {
    turnId: row.id,
    sessionId: row.sessionId,
    ownerId: row.leaseOwnerId,
    userId: row.userId,
    leaseVersion: row.leaseVersion,
    leaseStartedAt: date(row.leaseStartedAt),
    leaseExpiresAt: date(row.leaseExpiresAt),
  }
}

function validateWindow(leaseMs: number): void {
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > TURN_MAX_LEASE_MS) {
    throw new RangeError(`Turn lease window must be an integer between 1 and ${TURN_MAX_LEASE_MS}ms`)
  }
}

async function rollback(client: pg.PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined)
}

/** Claims with one conditional UPDATE. Never use a read-then-write claim. */
export async function claimTurnLease(
  pool: LeasePool,
  payload: TurnJobPayload,
  now = new Date(),
  leaseMs = TURN_LEASE_WINDOW_MS,
): Promise<TurnLease> {
  validateWindow(leaseMs)
  if (!parseTurnJobPayload(payload)) throw new TypeError("Invalid Turn lease payload")
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    const result = await client.query<LeaseRow>(
      `UPDATE "agent_turns"
       SET "status" = 'in_progress',
           "leaseOwnerId" = $3,
           "leaseStartedAt" = $4,
           "leaseExpiresAt" = $4 + ($5 * INTERVAL '1 millisecond'),
           "leaseVersion" = "leaseVersion" + 1,
           "revision" = "revision" + 1,
           "startedAt" = COALESCE("startedAt", $4),
           "updatedAt" = $4
       WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'queued'
         AND ("leaseOwnerId" IS NULL OR "leaseExpiresAt" <= $4)
       RETURNING "id", "sessionId", "userId", "leaseOwnerId", "leaseVersion",
                 "leaseStartedAt", "leaseExpiresAt"`,
      [payload.turnId, payload.sessionId, payload.ownerId, now, leaseMs],
    )
    const row = result.rows[0]
    await client.query("COMMIT")
    committed = true
    if (!row) throw new TurnLeaseError("lease_not_available", "Turn is no longer available for execution")
    return lease(row)
  } catch (error: unknown) {
    if (!committed) await rollback(client)
    throw error
  } finally {
    client.release()
  }
}

export async function renewTurnLease(
  pool: LeasePool,
  current: TurnLease,
  now = new Date(),
  leaseMs = TURN_LEASE_WINDOW_MS,
): Promise<TurnLease | null> {
  validateWindow(leaseMs)
  const client = await pool.connect()
  try {
    const result = await client.query<LeaseRow>(
      `UPDATE "agent_turns"
       SET "leaseExpiresAt" = LEAST(
             $6 + ($5 * INTERVAL '1 millisecond'),
             "leaseStartedAt" + ($7 * INTERVAL '1 millisecond')
           ),
           "updatedAt" = $6
       WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwnerId" = $3
         AND "leaseVersion" = $4 AND "status" = 'in_progress'
         AND "leaseExpiresAt" > $6
         AND "leaseStartedAt" + ($7 * INTERVAL '1 millisecond') > $6
       RETURNING "id", "sessionId", "userId", "leaseOwnerId", "leaseVersion",
                 "leaseStartedAt", "leaseExpiresAt"`,
      [current.turnId, current.sessionId, current.ownerId, current.leaseVersion, leaseMs, now, TURN_MAX_LEASE_MS],
    )
    return result.rows[0] ? lease(result.rows[0]) : null
  } finally {
    client.release()
  }
}

/** Leaves an in-progress Turn for the scanner after a lost heartbeat. */
export async function expireTurnLease(
  pool: LeasePool,
  current: TurnLease,
  now = new Date(),
): Promise<boolean> {
  const client = await pool.connect()
  try {
    const result = await client.query(
      `UPDATE "agent_turns"
       SET "leaseOwnerId" = NULL, "leaseExpiresAt" = $5, "leaseStartedAt" = NULL,
           "revision" = "revision" + 1, "updatedAt" = $5
       WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwnerId" = $3
         AND "leaseVersion" = $4 AND "status" = 'in_progress'`,
      [current.turnId, current.sessionId, current.ownerId, current.leaseVersion, now],
    )
    return result.rowCount === 1
  } finally {
    client.release()
  }
}

export async function releaseTurnLease(
  pool: LeasePool,
  current: TurnLease,
  status: LeaseReleaseStatus,
  now = new Date(),
): Promise<boolean> {
  const client = await pool.connect()
  try {
    const result = await client.query(
      `UPDATE "agent_turns"
       SET "status" = $5, "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
           "leaseStartedAt" = NULL, "revision" = "revision" + 1,
           "completedAt" = CASE WHEN $5 IN ('interrupted', 'failed', 'completed') THEN $6 ELSE NULL END,
           "updatedAt" = $6
       WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwnerId" = $3
         AND "leaseVersion" = $4 AND "status" = 'in_progress'`,
      [current.turnId, current.sessionId, current.ownerId, current.leaseVersion, status, now],
    )
    return result.rowCount === 1
  } finally {
    client.release()
  }
}

/** Fallback for the shutdown race where heartbeat already cleared ownership. */
export async function interruptTurnLease(
  pool: LeasePool,
  current: TurnLease,
  now = new Date(),
): Promise<boolean> {
  const client = await pool.connect()
  try {
    const result = await client.query(
      `UPDATE "agent_turns"
       SET "status" = 'interrupted', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
           "leaseStartedAt" = NULL, "revision" = "revision" + 1,
           "completedAt" = $5, "updatedAt" = $5
       WHERE "id" = $1 AND "sessionId" = $2 AND "leaseVersion" = $3
         AND "status" = 'in_progress'
         AND ("leaseOwnerId" = $4 OR ("leaseOwnerId" IS NULL AND "leaseExpiresAt" <= $5))`,
      [current.turnId, current.sessionId, current.leaseVersion, current.ownerId, now],
    )
    return result.rowCount === 1
  } finally {
    client.release()
  }
}
