import type pg from "pg"
import { rowToTask, SELECT_TASK, transaction } from "./pg-store-persistence.js"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./task-graph-child-deadline.js"
import type { PgSubagentPool, SubagentTaskRecord } from "./types.js"
import { settleExpiredNestedScoutDescendants } from "./nested-scout-deadline-terminal.js"
import type { NestedScoutDeadlineScope } from "./nested-scout-deadline-terminal.js"

const ACTIVE = "'queued', 'running', 'retrying', 'waiting', 'waiting_for_user'"
const TERMINAL_TURN = "'completed', 'failed', 'interrupted', 'cancelled'"
type Candidate = NestedScoutDeadlineScope

/** Bounded DB-clock scan, grouped by parent so sibling expiry is settled in one transaction. */
export async function recoverExpiredNestedScoutChildren(pool: PgSubagentPool, limit: number): Promise<SubagentTaskRecord[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Nested Scout deadline recovery limit must be positive")
  const candidates = await transaction(pool, async client => (await client.query<Candidate>(`SELECT DISTINCT parent."id" AS "parentScoutId",
      session."userId", child."sessionId", child."turnId", child."rootTaskId"
    FROM "sub_agent_tasks" AS child
    JOIN "sub_agent_tasks" AS parent ON parent."id" = child."parentTaskId" AND parent."sessionId" = child."sessionId"
      AND parent."turnId" = child."turnId" AND parent."rootTaskId" = child."rootTaskId"
    JOIN "sub_agent_tasks" AS root ON root."id" = child."rootTaskId" AND root."sessionId" = child."sessionId"
      AND root."turnId" = child."turnId" AND root."parentTaskId" IS NULL AND root."rootTaskId" = root."id"
    JOIN "agent_sessions" AS session ON session."id" = child."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = child."turnId" AND turn."sessionId" = child."sessionId"
      AND turn."userId" = session."userId" AND turn."rootTaskId" = root."id"
    WHERE child."depth" = 2 AND child."parentTaskId" = parent."id" AND parent."parentTaskId" = root."id"
      AND parent."depth" = 1 AND parent."role" = 'scout' AND parent."taskType" = 'job_discovery'
      AND child."role" = 'scout' AND child."taskType" = 'job_discovery' AND child."status" IN (${ACTIVE})
      AND child."absoluteDeadlineAt" <= clock_timestamp()
      AND (parent."status" IN (${ACTIVE}) OR (parent."status" = 'failed' AND parent."failureReason" = $2))
      AND (parent."absoluteDeadlineAt" IS NULL OR parent."absoluteDeadlineAt" > clock_timestamp())
      AND parent."interruptRequestedAt" IS NULL AND root."status" IN (${ACTIVE}) AND root."interruptRequestedAt" IS NULL
      AND session."status" NOT IN ('aborted', 'archived') AND turn."status" NOT IN (${TERMINAL_TURN})
    GROUP BY parent."id", session."userId", child."sessionId", child."turnId", child."rootTaskId"
    ORDER BY parent."id" LIMIT $1`, [limit, TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON])).rows)
  const recovered: SubagentTaskRecord[] = []
  for (const candidate of candidates) {
    const remaining = limit - recovered.length
    if (remaining <= 0) break
    const records = await transaction(pool, async client => {
      const ids = await settleExpiredNestedScoutDescendants(client, candidate, remaining)
      const tasks: SubagentTaskRecord[] = []
      for (const id of ids) {
        const result = await client.query(SELECT_TASK, [id, candidate.sessionId])
        const row = result.rows[0] as Record<string, unknown> | undefined
        if (!row) throw new Error("nested_scout_deadline_task_disappeared")
        tasks.push(rowToTask(row))
      }
      return tasks
    })
    recovered.push(...records)
  }
  return recovered
}
