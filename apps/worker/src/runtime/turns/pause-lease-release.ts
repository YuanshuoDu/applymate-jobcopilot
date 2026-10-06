import type pg from "pg"
import type { TurnLease } from "./lease.js"
import type { LeasePool } from "./lease.js"

export async function releaseTurnLeaseForPause(pool: LeasePool, current: TurnLease, now = new Date()): Promise<boolean> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [current.userId])
    const session = await client.query(`SELECT "id" FROM "agent_sessions"
      WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [current.sessionId, current.userId])
    if (!session.rows[0]) { await client.query("ROLLBACK"); committed = true; return false }
    const turn = await client.query<{ rootTaskId: string | null }>(`UPDATE "agent_turns" AS turn
      SET "status" = 'queued', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL,
        "revision" = turn."revision" + 1, "completedAt" = NULL, "updatedAt" = $5
      WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $6 AND turn."leaseOwnerId" = $3
        AND turn."leaseVersion" = $4 AND turn."status" = 'in_progress' AND turn."leaseExpiresAt" > $5
        AND EXISTS (SELECT 1 FROM "agent_events" AS pause WHERE pause."sessionId" = turn."sessionId"
          AND pause."turnId" = turn."id" AND pause."type" = 'session.pause_requested'
          AND NOT EXISTS (SELECT 1 FROM "agent_events" AS resumed WHERE resumed."sessionId" = pause."sessionId"
            AND resumed."turnId" = pause."turnId" AND resumed."type" = 'session.resume_requested' AND resumed."sequence" > pause."sequence"))
      RETURNING turn."rootTaskId"`, [current.turnId, current.sessionId, current.ownerId, current.leaseVersion, now, current.userId])
    const rootTaskId = turn.rows[0]?.rootTaskId
    if (!turn.rows[0]) { await client.query("ROLLBACK"); committed = true; return false }
    if (rootTaskId) {
      const root = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'queued', "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "completedAt" = NULL, "updatedAt" = $4
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1
          AND "status" = 'running' AND "leaseOwner" = $5 AND "attemptCount" = 1 AND "interruptRequestedAt" IS NULL`,
      [rootTaskId, current.sessionId, current.turnId, now, current.ownerId])
      if (root.rowCount !== 1) throw new Error("root_task_pause_release_fenced")
    }
    await client.query("COMMIT")
    committed = true
    return true
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
