import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import { settleExpiredNestedScoutDescendants } from "./nested-scout-deadline-terminal.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentScoutId: "parent-1" }
const now = new Date("2026-11-13T12:00:00.000Z")
const parentDeadline = new Date(now.getTime() + 60_000)
const expired = new Date(now.getTime() - 1)

function child(status: string, overrides: Record<string, unknown> = {}) {
  return { id: "child-1", sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.parentScoutId, path: "/root-1/parent-1/child-1", depth: 2,
    role: "scout", taskType: "job_discovery", status, absoluteDeadlineAt: expired,
    interruptRequestedAt: null, ...overrides }
}

function clientFor(input: { status: string; parentDeadline?: Date | null; children?: Record<string, unknown>[]; turnRootTaskId?: string }) {
  const graphEvent = { type: "item.started", itemId: taskGraphItemId(scope.rootTaskId), taskId: scope.rootTaskId,
    idempotencyKey: "graph-proposal", payload: { kind: "proposal", receipt: { revision: 1,
      nodes: [{ key: "scout", taskId: scope.parentScoutId, status: "queued" }], readyTaskIds: [scope.parentScoutId] } } }
  const query = vi.fn(async (sql: unknown, values?: unknown[]) => {
    const text = String(sql)
    if (text.includes('FROM "agent_events" AS event')) return { rows: [graphEvent], rowCount: 1 }
    if (text.includes('FROM "agent_sessions"')) return { rows: [{ userId: scope.userId, status: "running" }], rowCount: 1 }
    if (text.includes("set_config")) return { rows: [], rowCount: 1 }
    if (text.includes('FROM "agent_turns"')) return input.turnRootTaskId === undefined || input.turnRootTaskId === scope.rootTaskId
      ? { rows: [{ id: scope.turnId }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (text.includes('FROM "sub_agent_tasks" AS root')) return { rows: [{ id: scope.rootTaskId, path: `/${scope.rootTaskId}` }], rowCount: 1 }
    if (text.includes('FROM "sub_agent_tasks" AS parent')) return { rows: [{ id: scope.parentScoutId,
      sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.rootTaskId, path: `/${scope.rootTaskId}/${scope.parentScoutId}`, depth: 1,
      role: "scout", taskType: "job_discovery", status: "running", failureReason: null,
      interruptRequestedAt: null, absoluteDeadlineAt: input.parentDeadline ?? parentDeadline }], rowCount: 1 }
    if (text.includes('clock_timestamp() AS "now"')) return { rows: [{ now }], rowCount: 1 }
    if (text.includes('FROM "sub_agent_tasks" AS child')) return { rows: input.children ?? [child(input.status)], rowCount: (input.children ?? [child(input.status)]).length }
    if (text.startsWith('UPDATE "sub_agent_tasks"')) return { rows: [{ id: values?.[0] }], rowCount: 1 }
    if (text.startsWith('DELETE FROM "agent_outbox"')) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  })
  return query
}

describe("nested Scout deadline terminalization", () => {
  it.each(["queued", "waiting", "running"])("expires a %s child without requiring an expired lease", async status => {
    const query = clientFor({ status })
    await expect(settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope)).resolves.toEqual(["child-1"])
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE "sub_agent_tasks"'))
    expect(update?.[0]).toContain('"absoluteDeadlineAt" <= clock_timestamp()')
    expect(update?.[1]?.[5]).toBe("failed")
    expect(update?.[1]?.[7]).toBe("nested_scout_child_deadline_exceeded")
    expect(query.mock.calls.some(([sql]) => String(sql).includes('"leaseExpiresAt" <= clock_timestamp()'))).toBe(false)
  })

  it("preserves accepted interruption state while fencing an expired running owner", async () => {
    const query = clientFor({ status: "running", children: [child("running", { interruptRequestedAt: now })] })
    await settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope)
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE "sub_agent_tasks"'))
    expect(update?.[1]?.[5]).toBe("interrupted")
    expect(update?.[1]?.[6]).toBe(true)
    expect(update?.[0]).toContain('"leaseOwner" = NULL')
    expect(update?.[0]).toContain('"nextAttemptAt" = NULL')
  })

  it("fails closed on inheritance mismatch instead of skipping an unexpired child after parent expiry", async () => {
    const query = clientFor({ status: "waiting", parentDeadline: expired,
      children: [child("waiting", { absoluteDeadlineAt: new Date(now.getTime() + 1) })] })
    await expect(settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope))
      .rejects.toThrow("nested_scout_deadline_inheritance_invalid")
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("rejects malformed depth or ancestry rather than settling a foreign child", async () => {
    const query = clientFor({ status: "queued", children: [child("queued", { depth: 3 })] })
    await expect(settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope))
      .rejects.toThrow("nested_scout_deadline_child_lineage_invalid")
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("checks inherited child deadlines against the locked parent", async () => {
    const query = clientFor({ status: "queued", children: [child("queued", { absoluteDeadlineAt: new Date(parentDeadline.getTime() + 1) })] })
    await expect(settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope))
      .rejects.toThrow("nested_scout_deadline_inheritance_invalid")
  })

  it("settles no more than the independent sweep's remaining row budget", async () => {
    const query = clientFor({ status: "queued", children: [child("queued"), child("queued", {
      id: "child-2", path: "/root-1/parent-1/child-2",
    })] })
    await expect(settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope, 1)).resolves.toEqual(["child-1"])
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE "sub_agent_tasks"'))).toHaveLength(1)
  })

  it("leaves an expired parent to the canonical graph recovery when called with an independent budget", async () => {
    const query = clientFor({ status: "queued", parentDeadline: expired, children: [child("queued")] })
    await expect(settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope, 1)).resolves.toEqual([])
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM "sub_agent_tasks" AS child'))).toBe(false)
  })

  it("leaves a legacy Scout deadline row with no nested children unchanged", async () => {
    const query = clientFor({ status: "running", children: [] })
    await expect(settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope)).resolves.toEqual([])
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM "agent_events" AS event'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("rechecks the Turn's root pointer under lock before selecting descendants", async () => {
    const query = clientFor({ status: "queued", turnRootTaskId: "different-root" })
    await expect(settleExpiredNestedScoutDescendants({ query } as unknown as pg.PoolClient, scope)).resolves.toEqual([])
    const turnLock = query.mock.calls.find(([sql]) => String(sql).includes('FROM "agent_turns"'))
    expect(turnLock?.[0]).toContain('AND "rootTaskId" = $4')
    expect(turnLock?.[1]).toEqual([scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })
})
