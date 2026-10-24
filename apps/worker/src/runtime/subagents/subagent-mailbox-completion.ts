import type pg from "pg"

export const SUBAGENT_MAILBOX_PENDING_BATCH_SIZE = 20

type Queryable = Pick<pg.PoolClient, "query">
type PendingRow = { readonly id: string }

/** Reads bounded eligible input while finish holds the session/task completion locks. */
export async function findUnobservedMailboxMessageIds(
  client: Queryable,
  input: {
    readonly sessionId: string
    readonly taskId: string
    readonly attemptCount: number
    readonly observedMessageIds: readonly string[]
  },
): Promise<string[]> {
  const pending = await client.query<PendingRow>(`SELECT message."id"
    FROM "agent_mailbox_messages" AS message
    JOIN "sub_agent_tasks" AS target
      ON target."id" = message."toTaskId" AND target."sessionId" = message."sessionId"
    WHERE message."sessionId" = $1 AND message."toTaskId" = $2
      AND message."turnId" = target."turnId" AND message."consumedAt" IS NULL
      AND (message."targetAttemptCount" = $3
        OR (message."targetAttemptCount" IS NULL AND message."kind" <> 'human_follow_up'))
      AND NOT (message."id" = ANY($4::text[]))
    ORDER BY message."createdAt" ASC, message."id" ASC
    LIMIT $5
    FOR UPDATE OF message`, [input.sessionId, input.taskId, input.attemptCount, input.observedMessageIds, SUBAGENT_MAILBOX_PENDING_BATCH_SIZE])
  return pending.rows.map(row => row.id)
}
