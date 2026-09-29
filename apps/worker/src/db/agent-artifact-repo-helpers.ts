import type { Pool, PoolClient } from "pg"
import { RUNNABLE_SESSION } from "../runtime/session-gate.js"

export type AgentArtifactTaskFence = {
  readonly taskId: string
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly parentTaskId: string | null
  readonly leaseOwner: string
  readonly attemptCount: number
}

const TERMINAL_TURN = "('completed', 'failed', 'interrupted', 'cancelled')"
const TERMINAL_TASK = "('completed', 'failed', 'interrupted', 'cancelled', 'closed')"
const CURRENT_TASK = `SELECT task."id" FROM "sub_agent_tasks" AS task
  JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
  JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
  JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
  WHERE task."id" = $1 AND session."userId" = $2 AND turn."userId" = $2 AND task."sessionId" = $3 AND task."turnId" = $4
    AND task."rootTaskId" = $5 AND task."parentTaskId" IS NOT DISTINCT FROM $6
    AND task."status" = 'running' AND task."leaseOwner" = $7 AND task."attemptCount" = $8
    AND task."leaseExpiresAt" > clock_timestamp() AND task."interruptRequestedAt" IS NULL
    AND ${RUNNABLE_SESSION} AND turn."status" NOT IN ${TERMINAL_TURN}
    AND turn."rootTaskId" = root."id" AND root."rootTaskId" = root."id"
    AND root."status" NOT IN ${TERMINAL_TASK} AND root."interruptRequestedAt" IS NULL
    AND task."context"->'selectedJobPreparation'->>'jobId' = $9
  FOR UPDATE OF session, turn, root, task`

type QueryClient = Pick<Pool, "query">

export async function withArtifactTransaction<T>(pool: Pool, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    const value = await work(client)
    await client.query("COMMIT")
    return value
  } catch (error: unknown) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

/** Locks every authority row until the artifact transaction commits or rolls back. */
export async function artifactTaskFenceIsCurrent(client: QueryClient, fence: AgentArtifactTaskFence, jobId: string): Promise<boolean> {
  if (![fence.taskId, fence.userId, fence.sessionId, fence.turnId, fence.rootTaskId, fence.leaseOwner, jobId].every(value => typeof value === "string" && value.trim().length > 0)
    || !Number.isSafeInteger(fence.attemptCount) || fence.attemptCount < 1
    || (fence.parentTaskId !== null && (typeof fence.parentTaskId !== "string" || !fence.parentTaskId.trim()))) return false
  const current = await client.query(CURRENT_TASK, [fence.taskId, fence.userId, fence.sessionId, fence.turnId, fence.rootTaskId, fence.parentTaskId, fence.leaseOwner, fence.attemptCount, jobId])
  if (current.rows.length !== 1) return false
  if (fence.parentTaskId === null) return fence.taskId === fence.rootTaskId
  const parent = await client.query(
    `SELECT parent."id" FROM "sub_agent_tasks" AS parent WHERE parent."id" = $1 AND parent."sessionId" = $2
      AND parent."turnId" = $3 AND parent."rootTaskId" = $4 AND parent."status" NOT IN ${TERMINAL_TASK}
      AND parent."interruptRequestedAt" IS NULL FOR UPDATE`,
    [fence.parentTaskId, fence.sessionId, fence.turnId, fence.rootTaskId],
  )
  return parent.rows.length === 1
}

/** Rechecks wall-clock expiry immediately before the surrounding transaction commits. */
export async function artifactTaskLeaseIsLive(client: QueryClient, fence: AgentArtifactTaskFence): Promise<boolean> {
  const result = await client.query<{ live: boolean }>(
    `SELECT "leaseExpiresAt" > clock_timestamp() AS "live" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $4`,
    [fence.taskId, fence.sessionId, fence.leaseOwner, fence.attemptCount],
  )
  return result.rows[0]?.live === true
}
