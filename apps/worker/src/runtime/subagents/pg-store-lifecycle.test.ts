import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { interruptSubtree, interruptTree, interruptTurn, recoverExpired } from "./pg-store-lifecycle.js"
import type { PgSubagentPool } from "./types.js"

function fakePool(handler: (sql: string, params?: unknown[]) => { rows?: unknown[]; rowCount?: number } = () => ({ rowCount: 2 })) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      return { rows: [], rowCount: 0, ...handler(sql, params) }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool, calls, client }
}

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-1", parentTaskId: null,
    path: "/task-1", depth: 0, role: "scout", taskType: "test", status: "running", goal: "inspect",
    constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null,
    failureReason: null, attemptCount: 1, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date("2026-09-22T00:00:00Z"),
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ...overrides,
  }
}

describe("subagent PostgreSQL lifecycle helpers", () => {
  it("keeps interruption updates scoped to their session, Turn, or requested subtree", async () => {
    const tree = fakePool()
    await expect(interruptTree(tree.pool, { sessionId: "session-1", rootTaskId: "root-1", now: new Date() })).resolves.toBe(2)
    expect(tree.calls[0]?.[0]).toContain('"sessionId" = $1 AND "rootTaskId" = $2')

    const turn = fakePool()
    await interruptTurn(turn.pool, { userId: "user-1", sessionId: "session-1", turnId: "turn-1", now: new Date() })
    expect(turn.calls[0]?.[0]).toContain('session."userId" = $3')
    expect(turn.calls[0]?.[0]).toContain('task."turnId" = $2')

    const subtree = fakePool(sql => sql.startsWith('SELECT "id", "status"') ? { rows: [{ id: "session-1", status: "running" }] } : { rowCount: 1 })
    await expect(interruptSubtree(subtree.pool, { sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/child", now: new Date() })).resolves.toBe(1)
    expect(subtree.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0]).toContain('"path" LIKE $3 || \'/%\'')
  })

  it("does not mutate a closed session subtree and recovers expired tasks with bounded eligibility", async () => {
    const closed = fakePool(() => ({ rows: [{ id: "session-1", status: "archived" }], rowCount: 1 }))
    await expect(interruptSubtree(closed.pool, { sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1", now: new Date() })).resolves.toBe(0)
    expect(closed.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)

    const now = new Date("2026-09-23T12:00:00Z")
    const recovery = fakePool(sql => sql.includes('FROM "sub_agent_tasks" task') ? { rows: [taskRow({ sessionStatus: "running" })], rowCount: 1 } : { rowCount: 1 })
    await expect(recoverExpired(recovery.pool, { now, limit: 10 })).resolves.toMatchObject([
      { id: "task-1", status: "queued", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: expect.any(Date) },
    ])
    expect(recovery.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks" task'))?.[0]).toContain('"nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP')
    expect(recovery.calls.map(([sql]) => sql)).toContain("COMMIT")
    await expect(recoverExpired(recovery.pool, { now, limit: 0 })).rejects.toThrow("Recovery limit must be positive")
  })
})
