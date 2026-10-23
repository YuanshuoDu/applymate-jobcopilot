import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { CHILD_WAIT_RESUMABLE_SQL, dispatchTaskInvalidReason, lockDispatchTask, markDispatchTerminal } from "./subagent-dispatch-eligibility.js"
import type { SubagentJobPayload } from "../runtime/subagents/types.js"

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "session-1", rootTaskId: "root-1", turnId: "turn-1", status: "queued", attemptCount: 0, maxAttempts: 3,
    leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, rootId: "root-1", rootSessionId: "session-1",
    rootTurnId: "turn-1", rootStatus: "running", turnRowId: "turn-1", turnSessionId: "session-1", turnUserId: "user-1",
    turnStatus: "in_progress", retryDue: true, ...overrides,
  }
}

describe("subagent dispatch eligibility", () => {
  it("rejects terminal task rows", () => {
    expect(dispatchTaskInvalidReason(task({ status: "completed" }), payload, "session-1", "user-1")).toBe("task_terminal")
  })

  it("defers a future durable retry without terminalizing it", () => {
    expect(dispatchTaskInvalidReason(task({ retryDue: false }), payload, "session-1", "user-1")).toBe("retry_deferred")
  })

  it.each([
    ["scope", { sessionId: "other-session" }, "task_scope_invalid"],
    ["attempt", { attemptCount: 3 }, "attempts_exhausted"],
  ] as const)("rejects an invalid %s fence", (_label, overrides, reason) => {
    expect(dispatchTaskInvalidReason(task(overrides), payload, "session-1", "user-1")).toBe(reason)
  })

  it("permits only a database-proven durable child wait to resume at the attempt ceiling", () => {
    expect(dispatchTaskInvalidReason(task({ attemptCount: 3, childWaitResumable: true }), payload, "session-1", "user-1")).toBeNull()
    expect(dispatchTaskInvalidReason(task({ attemptCount: 3, childWaitResumable: false }), payload, "session-1", "user-1")).toBe("attempts_exhausted")
    expect(dispatchTaskInvalidReason(task({ status: "retrying", attemptCount: 3, childWaitResumable: true }), payload, "session-1", "user-1")).toBe("attempts_exhausted")
    expect(dispatchTaskInvalidReason(task({ attemptCount: 3, maxAttempts: 0, childWaitResumable: true }), payload, "session-1", "user-1")).toBe("attempts_exhausted")
    expect(dispatchTaskInvalidReason(task({ attemptCount: -1, childWaitResumable: true }), payload, "session-1", "user-1")).toBe("attempts_exhausted")
  })

  it("uses bound ownership values and proves the latest same-attempt wait and direct-child set", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as Pick<pg.PoolClient, "query">
    await lockDispatchTask(client, { taskId: "task-1", sessionId: "session-1", userId: "user-1" })
    const [sql, values] = vi.mocked(client.query).mock.calls[0] ?? []
    expect(values).toEqual(["task-1", "user-1", "session-1"])
    expect(sql).toContain('waitTurn."userId" = wait."userId"')
    expect(sql).toContain('waitTurn."rootTaskId" = task."rootTaskId"')
    expect(sql).toContain('currentStep."attempt" = task."attemptCount"')
    expect(sql).not.toContain(`task."attemptCount'`)
    expect(sql).toContain('step."ordinal" = (SELECT MAX(currentStep."ordinal")')
    expect(sql).toContain('continuation."ordinal" = (SELECT MIN(later."ordinal")')
    expect(sql).toContain('continuation."ordinal" = (SELECT MAX(currentStep."ordinal")')
    expect(sql).toContain('currentStep."attempt" = task."attemptCount"))))\n    AND wait."status" IN')
    expect(sql).toContain('step."status" IN (\'waiting_for_tool\', \'completed\')')
    expect(sql).toContain('wait."id" = (SELECT currentWait."id"')
    expect(sql).toContain('currentWaitStep."taskId" = task."id" AND currentWaitStep."attempt" = task."attemptCount"')
    expect(sql).not.toContain('currentWait."status" IN')
    expect(sql).not.toContain('currentWait."stepId" = step."id"')
    expect(sql).toContain('ORDER BY currentWaitStep."ordinal" DESC, currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1')
    expect(sql).toContain('wait."status" IN (\'ready\', \'timed_out\') AND wait."suspendedAt" IS NOT NULL')
    expect(sql).toContain('wait."consumedAt" IS NULL AND step."status" = \'waiting_for_tool\'')
    expect(sql.match(/wait\."consumedAt" IS NULL/g)).toHaveLength(1)
    expect(sql).toContain('child."parentTaskId" = task."id"')
    expect(sql).toContain('child."sessionId" = task."sessionId" AND child."turnId" = task."turnId"')
    expect(sql).toContain('child."rootTaskId" = task."rootTaskId"')
    expect(sql).toBeDefined()
    expect(CHILD_WAIT_RESUMABLE_SQL).not.toContain("user-1")
  })

  it("marks a terminal dispatch with a bounded reason", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) } as unknown as Pick<pg.PoolClient, "query">
    await markDispatchTerminal(client, "outbox-1", "task_missing")
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('"publishedAt" = CURRENT_TIMESTAMP'), ["outbox-1", "task_missing"])
  })
})
