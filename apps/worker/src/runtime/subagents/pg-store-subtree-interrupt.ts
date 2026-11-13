import type pg from "pg"
import { appendInternalAcceptedInterrupt } from "./task-interrupt-outbox.js"
import { deleteGraphDispatch, persistGraphTransition, prepareGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"

export type SubagentInterruptSelector = Readonly<{
  sessionId: string
  userId?: string
  turnId?: string
  rootTaskId?: string
  targetPath?: string
}>
type Candidate = Record<string, unknown> & Readonly<{ id: string; status: string; attemptCount: number; turnId?: string | null }>

/** Caller owns the Session FOR UPDATE lock and has set app.user_id for this transaction. */
export async function interruptMatchingInSession(
  client: Pick<pg.PoolClient, "query">,
  selector: SubagentInterruptSelector,
  userId: string,
  now: Date,
): Promise<number> {
  const { sql, values } = selectorWhere(selector)
  const selected = await client.query(`SELECT task."id", task."status", task."attemptCount", task."turnId" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE ${sql} AND session."userId" = $${values.length + 1}
      AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
    ORDER BY task."rootTaskId", task."id"`, [...values, userId])
  let changed = 0
  for (const raw of selected.rows as Candidate[]) {
    const running = raw.status === "running"
    const graph = running ? null : await prepareGraphTransition(client, {
      taskId: raw.id, sessionId: selector.sessionId, type: "task.interrupted", attemptCount: Number(raw.attemptCount),
    })
    if (graph && "blocked" in graph) continue
    const update = running
      ? `UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = COALESCE("interruptRequestedAt", $3), "updatedAt" = $3
          WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' RETURNING to_char("interruptRequestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "interruptRequestedAt"`
      : `UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = COALESCE("interruptRequestedAt", $3), "status" = 'interrupted',
          "nextAttemptAt" = NULL, "completedAt" = $3, "updatedAt" = $3
          WHERE "id" = $1 AND "sessionId" = $2 AND "status" = $4 RETURNING to_char("interruptRequestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "interruptRequestedAt"`
    const params = running ? [raw.id, selector.sessionId, now] : [raw.id, selector.sessionId, now, raw.status]
    const result = await client.query<{ interruptRequestedAt: string }>(update, params)
    if (result.rowCount !== 1) continue
    changed++
    if (selector.targetPath && typeof raw.turnId === "string" && raw.turnId) {
      await appendInternalAcceptedInterrupt(client, userId, {
        sessionId: selector.sessionId, turnId: raw.turnId, taskId: raw.id,
        interruptRequestedAt: result.rows[0]!.interruptRequestedAt,
      })
    }
    if (!running) {
      await deleteGraphDispatch(client, selector.sessionId, raw.id)
      if (graph) {
        await persistGraphTransition(client, graph, now)
        await reconcileGraphDependents(client, graph.scope, now)
      }
    }
  }
  return changed
}

function selectorWhere(selector: SubagentInterruptSelector): { sql: string; values: unknown[] } {
  const values: unknown[] = [selector.sessionId]
  const parts = [`task."sessionId" = $1`]
  if (selector.turnId) { values.push(selector.turnId); parts.push(`task."turnId" = $${values.length}`) }
  if (selector.rootTaskId) { values.push(selector.rootTaskId); parts.push(`task."rootTaskId" = $${values.length}`) }
  if (selector.targetPath) {
    values.push(selector.targetPath)
    parts.push(`(task."path" = $${values.length} OR left(task."path", char_length($${values.length}) + 1) = $${values.length} || '/')`)
  }
  return { sql: parts.join(" AND "), values }
}
