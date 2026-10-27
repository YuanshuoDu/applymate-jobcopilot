import type pg from "pg"
import { transaction } from "./pg-store-persistence.js"
import type { SubagentTaskRecord } from "./types.js"
import { expireTaskGraphChild } from "./pg-store-task-graph-deadline-terminal.js"

const ACTIVE = "'queued', 'running', 'retrying', 'waiting', 'waiting_for_user'"
const TERMINAL_TURN = "'completed', 'failed', 'interrupted', 'cancelled'"
type Candidate = Readonly<{ id: string; sessionId: string; turnId: string; rootTaskId: string; userId: string }>

/** Bounded DB-clock scan; each candidate is revalidated after the canonical ownership locks. */
export async function recoverExpiredTaskGraphChildren(pool: pg.Pool, limit: number): Promise<SubagentTaskRecord[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("TaskGraph deadline recovery limit must be positive")
  const candidates = await transaction(pool, async client => {
    return (await client.query<Candidate>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", session."userId"
      FROM "sub_agent_tasks" AS task
      JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
        AND turn."userId" = session."userId" AND turn."rootTaskId" = task."rootTaskId"
      JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
        AND root."turnId" = task."turnId" AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
      WHERE task."turnId" IS NOT NULL AND task."id" <> task."rootTaskId" AND task."parentTaskId" = task."rootTaskId"
        AND task."status" IN (${ACTIVE}) AND task."absoluteDeadlineAt" <= clock_timestamp()
        AND task."interruptRequestedAt" IS NULL AND session."status" NOT IN ('aborted', 'archived')
        AND turn."status" NOT IN (${TERMINAL_TURN}) AND root."status" IN (${ACTIVE}) AND root."interruptRequestedAt" IS NULL
        AND EXISTS (SELECT 1 FROM "agent_items" AS graph WHERE graph."sessionId" = task."sessionId"
          AND graph."turnId" = task."turnId" AND graph."taskId" = task."rootTaskId" AND graph."type" = 'task_graph')
      ORDER BY task."absoluteDeadlineAt", task."sessionId", task."id" LIMIT $1`, [limit])).rows
  })
  const recovered: SubagentTaskRecord[] = []
  for (const candidate of candidates) {
    const row = await transaction(pool, client => expireTaskGraphChild(client, candidate))
    if (row) recovered.push(row)
  }
  return recovered
}
