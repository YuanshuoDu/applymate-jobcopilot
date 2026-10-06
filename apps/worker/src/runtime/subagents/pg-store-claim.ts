import { RUNNABLE_SESSION, assertSessionWorkAdmission } from "../session-gate.js"
import { lockSubagentTurnForWork, readSubagentTask } from "./pg-store-create.js"
import { transaction } from "./pg-store-persistence.js"
import { persistGraphTransition, prepareGraphTransition } from "./task-graph-pg-lifecycle.js"
import type { PgSubagentPool, SubagentPolicy, SubagentTaskRecord } from "./types.js"

type ClaimInput = { taskId: string; sessionId: string; ownerId: string; rootTaskId?: string; policy: SubagentPolicy; now: Date }

/** Claims a queued child only after the owning Session, Turn, root, and child are fenced. */
export async function claimSubagentTask(pool: PgSubagentPool, input: ClaimInput, leaseMs: number): Promise<SubagentTaskRecord | null> {
  return transaction(pool, async client => {
    const session = await client.query(`SELECT session."id", session."userId", session."status" FROM "agent_sessions" AS session
      WHERE session."id" = $1 AND ${RUNNABLE_SESSION} FOR UPDATE`, [input.sessionId])
    const sessionRow = session.rows[0] as Record<string, unknown> | undefined
    if (!sessionRow || ["aborted", "archived"].includes(String(sessionRow.status))) return null
    const userId = String(sessionRow.userId)
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])

    const binding = await client.query(`SELECT "turnId", "rootTaskId" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [input.taskId, input.sessionId])
    const turnId = binding.rows[0]?.turnId
    const rootTaskId = binding.rows[0]?.rootTaskId
    if (typeof turnId !== "string" || !turnId || typeof rootTaskId !== "string" || (input.rootTaskId && rootTaskId !== input.rootTaskId)) return null
    await lockSubagentTurnForWork(client, { sessionId: input.sessionId, userId, turnId })

    const root = await client.query(`SELECT "id", "turnId", "status", "interruptRequestedAt" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [rootTaskId, input.sessionId, turnId])
    const rootRow = root.rows[0] as Record<string, unknown> | undefined
    if (!rootRow || rootRow.interruptRequestedAt != null || ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(rootRow.status))) return null

    const task = await client.query(`SELECT "id", "turnId", "rootTaskId", "status", "interruptRequestedAt" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 FOR UPDATE`, [input.taskId, input.sessionId])
    const taskRow = task.rows[0] as Record<string, unknown> | undefined
    if (!taskRow || taskRow.turnId !== turnId || taskRow.rootTaskId !== rootTaskId
      || taskRow.status !== "queued" || taskRow.interruptRequestedAt != null) return null

    await assertSessionWorkAdmission(client, { userId, sessionId: input.sessionId, turnId })
    const running = await client.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "status" = 'running' AND "leaseExpiresAt" > clock_timestamp()`, [input.sessionId])
    if (Number(running.rows[0]?.count ?? 0) >= input.policy.maxConcurrency) return null
    const graph = await prepareGraphTransition(client, { taskId: input.taskId, sessionId: input.sessionId, type: "task.started" })
    if (graph && "blocked" in graph) return null
    const updated = await client.query(`UPDATE "sub_agent_tasks"
      SET "status" = 'running', "leaseOwner" = $3, "leaseExpiresAt" = clock_timestamp() + ($4 * INTERVAL '1 millisecond'),
        "attemptCount" = "attemptCount" + 1, "startedAt" = COALESCE("startedAt", clock_timestamp()), "updatedAt" = clock_timestamp()
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $5 AND "rootTaskId" = $6
        AND "status" = 'queued' AND "interruptRequestedAt" IS NULL AND "attemptCount" < "maxAttempts"
        AND ("leaseOwner" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())
        AND EXISTS (SELECT 1 FROM "sub_agent_tasks" root WHERE root."id" = $6 AND root."sessionId" = $2
          AND root."turnId" = $5 AND root."interruptRequestedAt" IS NULL
          AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed'))`,
    [input.taskId, input.sessionId, input.ownerId, leaseMs, turnId, rootTaskId])
    if (updated.rowCount !== 1) return null
    if (graph) await persistGraphTransition(client, graph, input.now)
    return readSubagentTask(client, input.taskId, input.sessionId)
  })
}
