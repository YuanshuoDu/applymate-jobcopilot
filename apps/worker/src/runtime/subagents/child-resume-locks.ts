import type pg from "pg"
import { integer } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

type QueryClient = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

const TERMINAL_TURN_STATUSES = "('completed', 'failed', 'interrupted', 'cancelled')"
const TERMINAL_ROOT_STATUSES = "('completed', 'failed', 'interrupted', 'cancelled', 'closed')"

async function lockOne(client: QueryClient, sql: string, values: readonly unknown[]): Promise<void> {
  const result = await client.query<Row>(sql, [...values])
  if (result.rows.length !== 1) throw new Error("child_resume_owner_mismatch")
}

function currentTaskSql(): string {
  return `SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."status", task."leaseOwner", task."attemptCount", task."leaseExpiresAt", task."interruptRequestedAt", session."userId" AS "userId", turn."status" AS "turnStatus", root."status" AS "rootStatus"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5 AND task."status" = 'running' AND task."leaseOwner" = $6 AND task."attemptCount" = $7 AND task."leaseExpiresAt" > clock_timestamp() AND task."interruptRequestedAt" IS NULL AND session."status" NOT IN ('aborted', 'archived') AND turn."status" NOT IN ${TERMINAL_TURN_STATUSES} AND root."status" NOT IN ${TERMINAL_ROOT_STATUSES}`
}

function assertCurrentTask(row: Row, lease: SubagentLease, now: Date): void {
  if (row.id !== lease.id || row.userId !== lease.userId || row.sessionId !== lease.sessionId
    || row.turnId !== lease.turnId || row.rootTaskId !== lease.rootTaskId || row.leaseOwner !== lease.ownerId
    || integer(row, "attemptCount", 1) !== lease.attemptCount || row.status !== "running" || row.turnStatus === undefined
    || row.rootStatus === undefined || row.interruptRequestedAt !== null
    || typeof row.turnStatus !== "string" || TERMINAL_TURN_STATUSES.includes(`'${row.turnStatus}'`)
    || typeof row.rootStatus !== "string" || TERMINAL_ROOT_STATUSES.includes(`'${row.rootStatus}'`)) throw new Error("child_resume_owner_mismatch")
  const expires = row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : new Date(String(row.leaseExpiresAt))
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= now.getTime()) throw new Error("child_resume_lease_expired")
  if (lease.interruptRequestedAt !== null) throw new Error("child_resume_lease_expired")
}

/** Locks the scoped rows in the same order used by claim, heartbeat, and recovery writers, then revalidates the live lease. */
export async function lockAndLoadCurrentChildResume(client: QueryClient, lease: SubagentLease, now: Date): Promise<void> {
  await lockOne(client, `SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR SHARE`, [lease.sessionId, lease.userId])
  await lockOne(client, `SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR SHARE`,
    [lease.turnId, lease.sessionId, lease.userId])
  await lockOne(client, `SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR SHARE`,
    [lease.rootTaskId, lease.sessionId, lease.turnId])
  await lockOne(client, `SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 FOR SHARE`,
    [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId])
  const current = await client.query<Row>(currentTaskSql(), [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount])
  if (!current.rows[0]) throw new Error("child_resume_owner_mismatch")
  assertCurrentTask(current.rows[0], lease, now)
}