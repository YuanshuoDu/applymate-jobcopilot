import { describe, expect, it, vi } from "vitest"

const hooks = vi.hoisted(() => ({ settle: vi.fn() }))
vi.mock("./nested-scout-deadline-terminal.js", () => ({ settleExpiredNestedScoutDescendants: hooks.settle }))

import { recoverExpiredNestedScoutChildren } from "./nested-scout-deadline-recovery.js"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./task-graph-child-deadline.js"

describe("nested Scout deadline recovery", () => {
  it("rejects invalid bounds before acquiring a connection", async () => {
    const connect = vi.fn()
    await expect(recoverExpiredNestedScoutChildren({ connect } as never, 0)).rejects.toThrow("limit must be positive")
    await expect(recoverExpiredNestedScoutChildren({ connect } as never, 1.5)).rejects.toThrow("limit must be positive")
    expect(connect).not.toHaveBeenCalled()
  })

  it("scans only active depth-two read-only Scout children whose DB deadline expired", async () => {
    hooks.settle.mockReset()
    const query = vi.fn(async (_sql?: unknown, _values?: unknown[]) => ({ rows: [], rowCount: 0 }))
    const client = { query, release: vi.fn() }
    const connect = vi.fn().mockResolvedValue(client)
    await expect(recoverExpiredNestedScoutChildren({ connect } as never, 7)).resolves.toEqual([])
    const scan = query.mock.calls.find(([sql]) => String(sql).includes("SELECT DISTINCT parent."))
    expect(scan?.[0]).toContain('child."depth" = 2')
    expect(scan?.[0]).toContain('child."role" = \'scout\' AND child."taskType" = \'job_discovery\'')
    expect(scan?.[0]).toContain('child."absoluteDeadlineAt" <= clock_timestamp()')
    expect(scan?.[0]).toContain('(parent."absoluteDeadlineAt" IS NULL OR parent."absoluteDeadlineAt" > clock_timestamp())')
    expect(scan?.[0]).not.toContain('child."interruptRequestedAt" IS NULL')
    expect(scan?.[0]).toContain('ORDER BY parent."id" LIMIT $1')
    expect(scan?.[1]).toEqual([7, TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON])
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", expect.any(String), "COMMIT"])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("revalidates each parent scope in its own transaction and returns newly settled rows", async () => {
    hooks.settle.mockReset().mockResolvedValue(["child-1"])
    const candidate = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentScoutId: "parent-1" }
    const task = { id: "child-1", userId: candidate.userId, sessionId: candidate.sessionId, turnId: candidate.turnId,
      rootTaskId: candidate.rootTaskId, parentTaskId: candidate.parentScoutId, path: "/root-1/parent-1/child-1", depth: 2,
      role: "scout", taskType: "job_discovery", status: "failed", goal: "Inspect", result: null,
      failureReason: "nested_scout_child_deadline_exceeded", attemptCount: 1, maxAttempts: 3, constraints: [],
      successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {}, leaseOwner: null,
      leaseExpiresAt: null, absoluteDeadlineAt: new Date(), leaseSegmentStartedAt: null, nextAttemptAt: null,
      interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {} }
    const scanQuery = vi.fn(async (sql: unknown) => String(sql).includes("SELECT DISTINCT parent.")
      ? { rows: [candidate], rowCount: 1 } : { rows: [], rowCount: 0 })
    const taskQuery = vi.fn(async (sql: unknown) => String(sql).includes('FROM "sub_agent_tasks" task')
      ? { rows: [task], rowCount: 1 } : { rows: [], rowCount: 0 })
    const clients = [{ query: scanQuery, release: vi.fn() }, { query: taskQuery, release: vi.fn() }]
    let index = 0
    const connect = vi.fn(async () => clients[index++]!)
    await expect(recoverExpiredNestedScoutChildren({ connect } as never, 1)).resolves.toMatchObject([{ id: "child-1", status: "failed" }])
    expect(hooks.settle).toHaveBeenCalledWith(expect.anything(), candidate, 1)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(clients.every(value => value.release.mock.calls.length === 1)).toBe(true)
  })
})
