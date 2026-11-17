import type { Queryable } from "./pg-store-persistence.js"

export async function hasActiveSubagentDescendants(client: Queryable, input: {
  taskId: string
  sessionId: string
  turnId: string
  rootTaskId: string
}): Promise<boolean> {
  const result = await client.query<{ pending: boolean }>(`WITH RECURSIVE descendants AS (
      SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."status"
      FROM "sub_agent_tasks" AS task
      WHERE task."parentTaskId" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      UNION ALL
      SELECT child."id", child."sessionId", child."turnId", child."rootTaskId", child."status"
      FROM "sub_agent_tasks" AS child JOIN descendants AS parent
        ON child."parentTaskId" = parent."id" AND child."sessionId" = parent."sessionId"
          AND child."turnId" = parent."turnId" AND child."rootTaskId" = parent."rootTaskId"
    )
    SELECT EXISTS (SELECT 1 FROM descendants WHERE "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')) AS "pending"`,
  [input.taskId, input.sessionId, input.turnId, input.rootTaskId])
  return result.rows[0]?.pending === true
}
