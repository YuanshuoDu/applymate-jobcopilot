import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { releaseTurnLeaseForPause } from "./pause-lease-release.js"
import type { TurnLease } from "./lease.js"
import { prepareGraphTransition } from "../subagents/task-graph-pg-lifecycle.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-10-06T09:00:00Z"), leaseExpiresAt: new Date("2026-10-06T09:01:00Z"),
}

function fixture(rootRowCount = 1) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.startsWith('UPDATE "agent_turns"')) return { rows: [{ rootTaskId: "root-turn-1" }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rows: [], rowCount: rootRowCount }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<pg.Pool, "connect">, calls }
}

describe("pause lease release", () => {
  it("atomically queues the same Turn and root task after locking Session then Turn", async () => {
    const fake = fixture()
    const now = new Date("2026-10-06T09:00:30Z")

    await expect(releaseTurnLeaseForPause(fake.pool, lease, now)).resolves.toBe(true)

    const sessionIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"'))
    const turnIndex = fake.calls.findIndex(([sql]) => sql.startsWith('UPDATE "agent_turns"'))
    const rootIndex = fake.calls.findIndex(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(sessionIndex).toBeLessThan(turnIndex)
    expect(turnIndex).toBeLessThan(rootIndex)
    expect(fake.calls[turnIndex]?.[0]).toContain("session.pause_requested")
    expect(fake.calls[turnIndex]?.[0]).toContain("session.resume_requested")
    expect(fake.calls[rootIndex]?.[0]).toContain('"attemptCount" = 1')
    expect(fake.calls[rootIndex]?.[0]).toContain('"interruptRequestedAt" IS NULL')
    expect(fake.calls.some(([sql]) => sql.includes('"task_graph"') || sql.includes('"agent_items"'))).toBe(false)
    expect(fake.calls.at(-1)?.[0]).toBe("COMMIT")
  })

  it("rolls back if the bound root task cannot be released under its exact owner fence", async () => {
    const fake = fixture(0)

    await expect(releaseTurnLeaseForPause(fake.pool, lease)).rejects.toThrow("root_task_pause_release_fenced")
    expect(fake.calls.at(-1)?.[0]).toBe("ROLLBACK")
  })

  it("keeps the canonical root TaskGraph boundary explicit: only parent-linked descendants project nodes", async () => {
    const query = vi.fn(async () => ({ rows: [{ turnId: "turn-1", rootTaskId: "root-turn-1", parentTaskId: null, attemptCount: 1, userId: "user-1" }], rowCount: 1 }))
    await expect(prepareGraphTransition({ query } as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "root-turn-1", sessionId: "session-1", type: "task.retrying", attemptCount: 1,
    })).resolves.toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })
})
