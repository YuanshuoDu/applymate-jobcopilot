import { randomUUID } from "node:crypto"
import type { Queryable } from "./pg-store-persistence.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

/** Ensure a ready TaskGraph child has a pending, correctly scoped dispatch intent. */
export async function enqueueReadyGraphTask(client: Queryable, scope: GraphIdentityScope, taskId: string): Promise<void> {
  const idempotencyKey = `subagent-dispatch:${taskId}`
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`,
  [`subagent-dispatch-${randomUUID()}`, scope.sessionId, idempotencyKey, JSON.stringify({
    taskId, sessionId: scope.sessionId, rootTaskId: scope.rootTaskId, ownerId: `coordination-${randomUUID()}`,
  })])
  if (inserted.rowCount !== 0) return

  const existing = await client.query<{ payload: unknown; publishedAt: Date | string | null }>(`SELECT "payload", "publishedAt"
    FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
      AND "aggregateId" = $1 AND "idempotencyKey" = $2 FOR UPDATE`, [scope.sessionId, idempotencyKey])
  const dispatch = existing.rows[0]
  const payload = dispatch?.payload as Record<string, unknown> | undefined
  if (!dispatch || payload?.taskId !== taskId || payload?.sessionId !== scope.sessionId || payload?.rootTaskId !== scope.rootTaskId) {
    throw new Error("task_graph_dispatch_conflict")
  }
  if (dispatch.publishedAt === null) return

  const reset = await client.query(`UPDATE "agent_outbox" AS dispatch
    SET "publishedAt" = NULL, "attemptCount" = dispatch."attemptCount" + 1, "lastError" = NULL
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      AND turn."userId" = session."userId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId"
      AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    WHERE dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."aggregateId" = $1
      AND dispatch."idempotencyKey" = $2 AND dispatch."publishedAt" IS NOT NULL
      AND task."id" = $3 AND task."sessionId" = $1 AND task."turnId" = $4
      AND task."rootTaskId" = $5 AND task."parentTaskId" = $5 AND task."status" = 'queued'
      AND task."leaseOwner" IS NULL AND task."leaseExpiresAt" IS NULL AND task."interruptRequestedAt" IS NULL
      AND session."userId" = $6 AND session."status" NOT IN ('aborted', 'archived')
      AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
      AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')`,
  [scope.sessionId, idempotencyKey, taskId, scope.turnId, scope.rootTaskId, scope.userId])
  if (reset.rowCount !== 1) throw new Error("task_graph_dispatch_reset_fenced")
}
