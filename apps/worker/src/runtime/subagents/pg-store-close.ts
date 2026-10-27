import type pg from "pg"
import { persistGraphTransition, prepareGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"
import { transaction } from "./pg-store-persistence.js"
import type { PgSubagentPool } from "./types.js"

export async function closeSubagentTask(pool: PgSubagentPool, input: { taskId: string; sessionId: string; now: Date }): Promise<boolean> {
  return transaction(pool, async client => {
    const session = await client.query<{ userId: string }>(`SELECT "userId" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE`, [input.sessionId])
    const userId = session.rows[0]?.userId
    if (!userId) return false
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
    const task = await client.query(`SELECT task."attemptCount" FROM "sub_agent_tasks" AS task
      WHERE task."id" = $1 AND task."sessionId" = $2
        AND task."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`, [input.taskId, input.sessionId])
    if (!task.rows[0]) return false
    const graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.closed", attemptCount: Number((task.rows[0] as Record<string, unknown>).attemptCount) })
    if (graph && "blocked" in graph) return false
    const result = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'closed', "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL,
      "leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END,
      "closedAt" = $3, "completedAt" = $3, "updatedAt" = $3
      WHERE "id" = $1 AND "sessionId" = $2 AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`, [input.taskId, input.sessionId, input.now])
    if (result.rowCount !== 1) return false
    if (graph) {
      await persistGraphTransition(client, graph, input.now)
      await reconcileGraphDependents(client, graph.scope, input.now)
    }
    return true
  })
}