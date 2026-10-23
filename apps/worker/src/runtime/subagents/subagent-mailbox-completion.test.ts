import type pg from "pg"
import { describe, expect, it, vi } from "vitest"

import { findUnobservedMailboxMessageIds, SUBAGENT_MAILBOX_PENDING_BATCH_SIZE } from "./subagent-mailbox-completion.js"

describe("findUnobservedMailboxMessageIds", () => {
  it("locks only bounded, eligible same-target and same-attempt mailbox rows", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [{ id: "message-new" }, { id: "message-next" }] }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">

    await expect(findUnobservedMailboxMessageIds(client, {
      sessionId: "session-1", taskId: "task-1", attemptCount: 3, observedMessageIds: ["message-seen"],
    })).resolves.toEqual(["message-new", "message-next"])

    const [sql, values] = query.mock.calls[0]!
    expect(sql).toContain('message."sessionId" = $1 AND message."toTaskId" = $2')
    expect(sql).toContain('message."turnId" = target."turnId"')
    expect(sql).toContain('message."targetAttemptCount" = $3')
    expect(sql).toContain('message."kind" <> \'human_follow_up\'')
    expect(sql).toContain('message."id" = ANY($4::text[])')
    expect(sql).toContain("FOR UPDATE OF message")
    expect(values).toEqual(["session-1", "task-1", 3, ["message-seen"], SUBAGENT_MAILBOX_PENDING_BATCH_SIZE])
    expect(SUBAGENT_MAILBOX_PENDING_BATCH_SIZE).toBe(20)
    expect(sql.trimStart()).toMatch(/^SELECT\b/i)
    expect(sql).not.toMatch(/;\s*(?:SELECT|UPDATE|INSERT|DELETE)\b/i)
  })
})
