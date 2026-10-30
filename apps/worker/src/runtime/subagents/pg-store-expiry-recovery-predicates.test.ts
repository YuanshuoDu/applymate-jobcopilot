import { describe, expect, it, vi } from "vitest"
import {
  CHILD_WAIT_CONSUMED_SQL,
  CHILD_WAIT_RESUMABLE_SQL,
  hasBlockingExternalCall,
} from "./pg-store-expiry-recovery-predicates.js"

const task = {
  id: "parent-1",
  sessionId: "session-1",
  turnId: "turn-1",
  rootTaskId: "root-1",
  leaseOwner: "owner-1",
  attemptCount: 3,
  leaseExpiresAt: new Date("2026-10-06T10:00:00.000Z"),
  userId: "user-1",
}

describe("expired recovery SQL predicates", () => {
  it("keeps ready child waits scoped to the same Session, Turn, root, attempt, and parent", () => {
    expect(CHILD_WAIT_RESUMABLE_SQL).toContain('waitTurn."sessionId" = wait."sessionId"')
    expect(CHILD_WAIT_RESUMABLE_SQL).toContain('waitTurn."userId" = $3 AND waitTurn."rootTaskId" = task."rootTaskId"')
    expect(CHILD_WAIT_RESUMABLE_SQL).toContain('wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"')
    expect(CHILD_WAIT_RESUMABLE_SQL).toContain('step."attempt" = task."attemptCount"')
    expect(CHILD_WAIT_RESUMABLE_SQL).toContain('wait."status" IN (\'ready\', \'timed_out\') AND wait."suspendedAt" IS NOT NULL')
    expect(CHILD_WAIT_RESUMABLE_SQL).toContain('child."id" <> task."id" AND child."parentTaskId" = task."id"')
    expect(CHILD_WAIT_RESUMABLE_SQL).toContain('child."sessionId" = task."sessionId" AND child."turnId" = task."turnId"')
    expect(CHILD_WAIT_RESUMABLE_SQL).toContain('child."rootTaskId" = task."rootTaskId"')
  })

  it("keeps consumed continuation evidence correlated to the current wait and attempt", () => {
    expect(CHILD_WAIT_CONSUMED_SQL).toContain('waitTurn."userId" = $3 AND waitTurn."rootTaskId" = task."rootTaskId"')
    expect(CHILD_WAIT_CONSUMED_SQL).toContain('wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"')
    expect(CHILD_WAIT_CONSUMED_SQL).toContain('wait."consumedAt" IS NOT NULL')
    expect(CHILD_WAIT_CONSUMED_SQL).toContain('source."attempt" = task."attemptCount"')
    expect(CHILD_WAIT_CONSUMED_SQL).toContain('continuation."status" = \'streaming\'')
    expect(CHILD_WAIT_CONSUMED_SQL).toContain('currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId" AND currentWait."turnId" = task."turnId"')
  })

  it("keeps unresolved external calls fenced by event correlation and exact wait ownership", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "unsettled-start" }] })
    const client = { query }
    await expect(hasBlockingExternalCall(client as never, task, "ignored-event", "continuation-1")).resolves.toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0] as [string, unknown[]]
    expect(values).toEqual([task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount,
      task.leaseExpiresAt, task.userId, "ignored-event", "continuation-1"])
    expect(sql).toContain('started."sessionId" = $1 AND started."taskId" = $2')
    expect(sql).toContain('settled."correlationId" = started."correlationId"')
    expect(sql).toContain('settled."type" IN (\'tool_call.completed\', \'tool_call.failed\', \'tool_call.interrupted\')')
    expect(sql).toContain('owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7')
    expect(sql).toContain('wait."sessionId" = $1 AND wait."turnId" = $3 AND wait."userId" = $8')
    expect(sql).toContain('call."content"->>\'toolCallId\' = started."correlationId"')
    expect(sql).toContain('AND ($9::text IS NULL OR started."id" <> $9)')
    expect(sql).toContain('$10::text IS NOT NULL')
    expect(sql).toContain('WITH latest_wait AS MATERIALIZED')
    expect(sql).toContain('LEFT JOIN LATERAL')
  })

  it("only allows the exact consumed-wait continuation claim through expiry recovery", async () => {
    const deadline = new Date("2026-10-06T10:00:00.000Z")
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "claim-start", claimWaitId: "wait-1", waitDeadlineAt: deadline, outcomeDeadlineAt: deadline.toISOString() }] })
    const client = { query }
    await expect(hasBlockingExternalCall(client as never, task, undefined, "continuation-1")).resolves.toBe(false)
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0] as [string, unknown[]]
    expect(values).toEqual([task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount,
      task.leaseExpiresAt, task.userId, null, "continuation-1"])
    expect(sql).toContain('LEFT JOIN LATERAL (SELECT latest_wait."id" AS "waitId"')
    expect(sql).toContain('FROM latest_wait WHERE started."type" = \'tool_call.started\' AND $10::text IS NOT NULL AND EXISTS (')
    expect(sql).toContain("started.\"idempotencyKey\" = 'task:' || owner.\"id\" || ':event:child-wait-claim:' || owner.\"attemptCount\"::text || ':' || continuation.\"id\"")
    expect(sql).toContain('started."causationId" = itemStarted."id"')
    expect(sql).toContain('itemStarted."sequence" < started."sequence"')
    expect(sql).toContain('itemStarted."idempotencyKey" = \'task:\' || owner."id" || \':event:item-started:\' || claimedCall."id"')
    expect(sql).toContain('LEFT JOIN "agent_items" AS sourceResult')
    expect(sql).toContain('claimedCall."stepId" = continuation."id"')
    expect(sql).toContain('owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7')
    expect(sql).toContain('continuation."ordinal" = (SELECT MAX(current."ordinal")')
    expect(sql).toContain("sourceResult.\"status\" = 'completed'")
    expect(sql).toContain('sourceCall."status" = \'started\'')
    expect(sql).toContain('sourceCall."revision" = 0')
    expect(sql).toContain('sourceResult."id" IS NULL')
    expect(sql).toContain("SELECT COUNT(*) FROM jsonb_object_keys(wait.\"result\"->'outcome')")
    expect(sql).toContain("wait.\"result\"->'outcome' ?& ARRAY['waitId', 'status', 'taskIds', 'deadlineAt', 'matchedTaskIds', 'tasks']")
    expect(sql).toContain("sourceResult.\"content\"->'output'->>'deadlineAt' = wait.\"result\"->'outcome'->>'deadlineAt'")
    expect(sql).toContain(`claimedCall."status" = 'completed' AND claimedCall."revision" = 1`)
    expect(sql).toContain(`stepCall."stepId" = continuation."id" AND stepCall."type" = 'tool_call') = 1`)
    expect(sql).toContain(`(itemCompleted."itemId" = claimedCall."id" OR itemCompleted."correlationId" = claimedCall."id")`)
    expect(sql).toContain(`extra."itemId" = claimedCall."id" OR extra."correlationId" = claimedCall."id"`)
    expect(sql).toContain(`claimedCall."status" = 'completed' AND extra."correlationId" = started."correlationId"`)
    expect(sql).toContain(`extra."type" = 'item.completed' AND extra."itemId" = claimedCall."id" AND extra."actor" = 'subagent'`)
    expect(sql).toContain("jsonb_typeof(sourceResult.\"content\"->'output'->'taskIds') = 'array'")
    expect(sql).toContain('AS receiptTarget(id) ORDER BY id)) = (SELECT ARRAY(SELECT id FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds")')
    expect(sql).toContain("wait.\"result\"->'outcome'->>'deadlineAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T")
    expect(sql).toContain("clock_timestamp() AT TIME ZONE 'UTC'")
    expect(sql).toContain("jsonb_typeof(wait.\"result\"->'outcome'->'tasks') = 'array'")
    expect(sql).toContain("SELECT COUNT(*) FROM jsonb_object_keys(saved.value)")
    expect(sql).toContain("jsonb_typeof(saved.value->'failureReason') IN ('null', 'string')")
    expect(sql).toContain("CASE WHEN jsonb_typeof(claimedCall.\"content\"->'input') = 'object' THEN (claimedCall.\"content\"->'input') - 'taskIds'::text ELSE '{}'::jsonb END")
    expect(sql).toContain("CASE WHEN jsonb_typeof(sourceCall.\"content\"->'input') = 'object' THEN (sourceCall.\"content\"->'input') - 'taskIds'::text ELSE '{}'::jsonb END")
    expect(sql).toContain("CASE WHEN jsonb_typeof(call.\"content\"->'input') = 'object' THEN (call.\"content\"->'input') - 'taskIds'::text ELSE '{}'::jsonb END")
    expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM "agent_items" AS result')
    expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra')
  })

  it("blocks a valid-looking continuation claim when its receipt deadline differs from the database wait", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "claim-start", claimWaitId: "wait-1",
      waitDeadlineAt: new Date("2026-10-06T10:00:00.000Z"), outcomeDeadlineAt: "2026-10-06T10:00:01.000Z" }] })
    await expect(hasBlockingExternalCall({ query } as never, task, undefined, "continuation-1")).resolves.toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("fails closed when deadline rows are invalid or multiple claim/blocker rows appear", async () => {
    for (const rows of [
      [{ id: "claim-start", claimWaitId: "wait-1", waitDeadlineAt: new Date(Number.NaN), outcomeDeadlineAt: "2026-10-06T10:00:00.000Z" }],
      [{ id: "claim-start", claimWaitId: "wait-1", waitDeadlineAt: new Date("2026-10-06T10:00:00.000Z"), outcomeDeadlineAt: null }],
      [{ id: "claim-start", claimWaitId: "wait-1", waitDeadlineAt: new Date("2026-03-02T10:00:00.000Z"), outcomeDeadlineAt: "2026-02-30T10:00:00.000Z" }],
      [
        { id: "claim-start", claimWaitId: "wait-1", waitDeadlineAt: new Date("2026-10-06T10:00:00.000Z"), outcomeDeadlineAt: "2026-10-06T10:00:00.000Z" },
        { id: "other-start", claimWaitId: null, waitDeadlineAt: null, outcomeDeadlineAt: null },
      ],
    ]) {
      await expect(hasBlockingExternalCall({ query: vi.fn().mockResolvedValue({ rows }) } as never, task, undefined, "continuation-1")).resolves.toBe(true)
    }
  })

  it("does not apply the continuation-claim exemption without an exact continuation step", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "unsettled-start" }] })
    const client = { query }
    await expect(hasBlockingExternalCall(client as never, task)).resolves.toBe(true)
    const [sql, values] = query.mock.calls[0] as [string, unknown[]]
    expect(values[9]).toBeNull()
    expect(sql).toContain("started.\"type\" = 'tool_call.started' AND $10::text IS NOT NULL")
  })

  it("returns false when no unmatched external-call start is returned", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await expect(hasBlockingExternalCall(client as never, task)).resolves.toBe(false)
  })
})
