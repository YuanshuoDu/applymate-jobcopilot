import type { Queryable } from "./pg-store-persistence.js"

/** True means a persisted external start has no durable matching terminal event yet. */
export async function hasUnsettledExternalCall(client: Queryable, sessionId: string, taskId: string): Promise<boolean> {
  const result = await client.query(`SELECT started."id" FROM "agent_events" AS started
    WHERE started."sessionId" = $1 AND started."taskId" = $2
      AND started."type" IN ('tool_call.started', 'model.started')
      AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled
        WHERE settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
          AND settled."correlationId" = started."correlationId"
          AND ((started."type" = 'tool_call.started' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))
            OR (started."type" = 'model.started' AND settled."type" IN ('model.completed', 'model.failed'))))
    LIMIT 1`, [sessionId, taskId])
  return result.rows.length > 0
}
