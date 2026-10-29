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
  })

  it("only allows the exact consumed-wait continuation claim through expiry recovery", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const client = { query }
    await expect(hasBlockingExternalCall(client as never, task, undefined, "continuation-1")).resolves.toBe(false)
    const [sql, values] = query.mock.calls[0] as [string, unknown[]]
    expect(values).toEqual([task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount,
      task.leaseExpiresAt, task.userId, null, "continuation-1"])
    expect(sql).toContain('AND NOT (started."type" = \'tool_call.started\' AND $10::text IS NOT NULL AND EXISTS (')
    expect(sql).toContain("started.\"idempotencyKey\" = 'task:' || owner.\"id\" || ':event:child-wait-claim:' || $6::text || ':' || continuation.\"id\"")
    expect(sql).toContain('started."causationId" = itemStarted."id"')
    expect(sql).toContain('itemStarted."idempotencyKey" = \'task:\' || owner."id" || \':event:item-started:\' || call."id"')
    expect(sql).toContain('call."stepId" = continuation."id"')
    expect(sql).toContain('owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7')
    expect(sql).toContain('continuation."ordinal" = (SELECT MAX(current."ordinal")')
    expect(sql).toContain('(call."content"->\'input\' - \'taskIds\') = jsonb_build_object(\'idempotencyKey\', wait."idempotencyKey"')
    expect(sql).toContain("jsonb_object_length(wait.\"result\"->'outcome') = 6")
    expect(sql).toContain("wait.\"result\"->'outcome' ?& ARRAY['waitId', 'status', 'taskIds', 'deadlineAt', 'matchedTaskIds', 'tasks']")
    expect(sql).toContain("wait.\"result\"->'outcome'->>'deadlineAt' = to_char(wait.\"deadlineAt\"")
    expect(sql).toContain("jsonb_typeof(wait.\"result\"->'outcome'->'tasks') = 'array'")
    expect(sql).toContain("jsonb_object_length(saved.value) = 5")
    expect(sql).toContain("jsonb_typeof(saved.value->'failureReason') IN ('null', 'string')")
    expect(sql).toContain("wait.\"status\" <> 'timed_out' OR wait.\"deadlineAt\" <= clock_timestamp()")
    expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM "agent_items" AS result')
    expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM "agent_events" AS extra')
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
