import { describe, expect, it, vi } from "vitest"
import { lockAndLoadCurrentChildResume } from "./child-resume-locks.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
const expires = new Date("2099-09-14T12:00:00.000Z")
const lease: SubagentLease = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "running", goal: "Find jobs",
  constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {},
  modelProfileSnapshot: {}, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1",
  leaseExpiresAt: expires, interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1",
  signal: new AbortController().signal,
}
function current(overrides: Row = {}): Row {
  return { id: lease.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: lease.rootTaskId,
    status: "running", leaseOwner: lease.ownerId, attemptCount: lease.attemptCount, leaseExpiresAt: expires,
    interruptRequestedAt: null, turnStatus: "in_progress", rootStatus: "running", ...overrides }
}

function fakeClient(missingLock?: number, final = current()) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const client = { query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_sessions"') && sql.includes('FOR SHARE')) return { rows: missingLock === 0 ? [] : [{ id: lease.sessionId }] }
    if (sql.includes('FROM "agent_turns"') && sql.includes('FOR SHARE')) return { rows: missingLock === 1 ? [] : [{ id: lease.turnId }] }
    if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('FOR SHARE')) {
      const childLock = sql.includes('"rootTaskId" = $4')
      return { rows: missingLock === (childLock ? 3 : 2) ? [] : [{ id: childLock ? lease.id : lease.rootTaskId }] }
    }
    if (sql.includes('JOIN "agent_sessions" AS session') && sql.includes('JOIN "agent_turns" AS turn')) return { rows: final ? [final] : [] }
    throw new Error("unexpected query")
  }) }
  return { client, calls }
}

describe("child resume scope locks", () => {
  it("locks session, turn, root and child in order before joined lease revalidation", async () => {
    const db = fakeClient()
    await lockAndLoadCurrentChildResume(db.client as never, lease, new Date("2099-09-14T11:00:00.000Z"))
    expect(db.calls.map(({ sql }) => {
      if (sql.includes('FROM "agent_sessions"')) return "session"
      if (sql.includes('FROM "agent_turns"')) return "turn"
      if (sql.startsWith('SELECT "id" FROM "sub_agent_tasks"') && sql.includes('"rootTaskId" = $4')) return "child"
      if (sql.startsWith('SELECT "id" FROM "sub_agent_tasks"')) return "root"
      return "joined-recheck"
    })).toEqual(["session", "turn", "root", "child", "joined-recheck"])
    expect(db.calls.slice(0, 4).every(({ sql }) => sql.endsWith("FOR SHARE"))).toBe(true)
    expect(db.calls.slice(0, 4).map(({ values }) => values)).toEqual([
      [lease.sessionId, lease.userId], [lease.turnId, lease.sessionId, lease.userId],
      [lease.rootTaskId, lease.sessionId, lease.turnId], [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId],
    ])
    expect(db.calls[4]?.values).toEqual([lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount])
    expect(db.calls[4]?.sql).not.toContain("FOR SHARE")
    expect(db.calls[4]?.sql).toContain('task."leaseExpiresAt" > clock_timestamp()')
    expect(db.calls[4]?.sql).toContain("session.\"status\" NOT IN ('aborted', 'archived')")
    expect(db.calls[4]?.sql).toContain("turn.\"status\" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')")
    expect(db.calls[4]?.sql).toContain("root.\"status\" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')")
  })

  it.each([0, 1, 2, 3])("stops and rejects when scope lock %s cannot be acquired", async missingLock => {
    const db = fakeClient(missingLock)
    await expect(lockAndLoadCurrentChildResume(db.client as never, lease, new Date())).rejects.toThrow("child_resume_owner_mismatch")
    expect(db.calls).toHaveLength(missingLock + 1)
  })

  it.each([
    { leaseOwner: "other-worker" }, { attemptCount: lease.attemptCount + 1 }, { turnStatus: "failed" },
    { rootStatus: "closed" }, { status: "failed" }, { interruptRequestedAt: new Date() },
  ])("rejects a joined row that no longer matches the running lease: %o", async overrides => {
    const db = fakeClient(undefined, current(overrides))
    await expect(lockAndLoadCurrentChildResume(db.client as never, lease, new Date("2099-09-14T11:00:00.000Z")))
      .rejects.toThrow("child_resume_owner_mismatch")
  })

  it("rejects an expired lease after acquiring the scoped locks", async () => {
    const db = fakeClient(undefined, current({ leaseExpiresAt: new Date("2099-09-14T10:00:00.000Z") }))
    await expect(lockAndLoadCurrentChildResume(db.client as never, lease, new Date("2099-09-14T11:00:00.000Z")))
      .rejects.toThrow("child_resume_lease_expired")
  })
})
