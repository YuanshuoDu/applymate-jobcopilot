import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { SessionPauseRequestedError } from "../session-gate.js"
import { claimSubagentTask } from "./pg-store-claim.js"
import { normalizeSubagentPolicy } from "./types.js"

const input = {
  taskId: "child-1", sessionId: "session-1", ownerId: "worker-1", rootTaskId: "root-1",
  policy: normalizeSubagentPolicy({ maxConcurrency: 2 }), now: new Date("2026-10-06T10:00:00Z"),
}

function poolFixture(options: { pause?: boolean; rootInterrupted?: boolean; turnUnavailable?: boolean } = {}) {
  const calls: string[] = []
  const task = { id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    path: "/root-1/child-1", depth: 1, role: "analyst", taskType: "test", status: "running", goal: "inspect", constraints: [],
    successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, attemptCount: 1, maxAttempts: 3,
    leaseOwner: "worker-1", leaseExpiresAt: new Date("2026-10-06T10:01:00Z"), interruptRequestedAt: null }
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions" AS session') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
      if (sql.includes('SELECT set_config')) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT "turnId", "rootTaskId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return options.turnUnavailable
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id", "turnId", "status", "interruptRequestedAt"')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: options.rootInterrupted ? new Date() : null }], rowCount: 1 }
      if (sql.includes('SELECT "id", "turnId", "rootTaskId", "status", "interruptRequestedAt"')) return { rows: [{ id: "child-1", turnId: "turn-1", rootTaskId: "root-1", status: "queued", interruptRequestedAt: null }], rowCount: 1 }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) return options.pause ? { rows: [], rowCount: 0 } : { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('SELECT task."turnId", task."rootTaskId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null, attemptCount: 0, userId: "user-1" }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rows: [], rowCount: 1 }
      if (sql.startsWith("SELECT task.*")) return { rows: [task], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<pg.Pool, "connect">, calls, client }
}

describe("atomic child claim pause fence", () => {
  it("locks Session and Turn, checks fresh admission, then locks root and child before incrementing attempt", async () => {
    const fake = poolFixture()
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toMatchObject({ id: "child-1", attemptCount: 1 })
    const at = (part: string) => fake.calls.findIndex(sql => sql.includes(part))
    const session = at('FROM "agent_sessions" AS session')
    const turn = at('FROM "agent_turns"')
    const admission = at('SELECT session."id" FROM "agent_sessions"')
    const root = at('SELECT "id", "turnId", "status", "interruptRequestedAt"')
    const child = at('SELECT "id", "turnId", "rootTaskId", "status", "interruptRequestedAt"')
    const update = fake.calls.findIndex(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(session).toBeLessThan(turn)
    expect(turn).toBeLessThan(admission)
    expect(admission).toBeLessThan(root)
    expect(root).toBeLessThan(child)
    expect(admission).toBeLessThan(update)
  })

  it("does not claim or spend an attempt when pause admission is denied", async () => {
    const fake = poolFixture({ pause: true })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.at(-1)).toBe("ROLLBACK")
  })

  it("returns the existing non-admission result for an unavailable Turn before claim writes", async () => {
    const fake = poolFixture({ turnUnavailable: true })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toBeNull()
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(sql => sql.includes("COUNT(*)::int"))).toBe(false)
    expect(fake.calls.at(-1)).toBe("COMMIT")
  })

  it("does not claim a child after the locked root has been interrupted", async () => {
    const fake = poolFixture({ rootInterrupted: true })
    await expect(claimSubagentTask(fake.pool, input, 60_000)).resolves.toBeNull()
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })
})
