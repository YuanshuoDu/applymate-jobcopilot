import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { recoverExpired } from "./pg-store-expiry-recovery.js"
import type { PgSubagentPool } from "./types.js"

const checkedAt = new Date("2026-10-06T10:00:00Z")
function fixture(options: { pendingCall?: boolean; candidate?: boolean } = {}) {
  const calls: string[] = []
  const task = { id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-1", parentTaskId: null,
    path: "/task-1", depth: 0, role: "scout", taskType: "scout", status: "running", goal: "inspect", constraints: [], successCriteria: [],
    allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 1, maxAttempts: 3,
    leaseOwner: "worker-1", leaseExpiresAt: new Date(checkedAt.getTime() - 1_000), nextAttemptAt: null, interruptRequestedAt: null,
    budgetSnapshot: {}, toolPolicySnapshot: {} }
  const client = { query: vi.fn(async (sql: string, _values?: unknown[]) => {
    calls.push(sql)
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1")) return options.candidate === false ? { rows: [], rowCount: 0 } : { rows: [{ id: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, turnId: task.turnId, userId: task.userId }], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: task.sessionId, userId: task.userId, status: "running" }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: task.turnId }], rowCount: 1 }
    if (sql.includes('session."status" AS "sessionStatus"')) return { rows: [{ ...task, sessionStatus: "running", rootStatus: "running", rootInterruptRequestedAt: null }], rowCount: 1 }
    if (sql.startsWith('SELECT task.*') && sql.includes("FOR UPDATE OF task")) return { rows: [{ ...task, sessionStatus: "running", rootStatus: "running", rootInterruptRequestedAt: null }], rowCount: 1 }
    if (sql.startsWith("SELECT clock_timestamp()")) return { rows: [{ checkedAt }], rowCount: 1 }
    if (sql.includes('FROM "agent_events" AS started')) return options.pendingCall ? { rows: [{ id: "started-event" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3')) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<pg.Pool, "connect">, calls, client }
}

describe("expired subagent recovery fence", () => {
  it("recovers only an explicitly expired lease with no unmatched model or tool start", async () => {
    const fake = fixture()
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toMatchObject([{ id: "task-1", status: "queued" }])
    const session = fake.calls.findIndex(sql => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const turn = fake.calls.findIndex(sql => sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE"))
    const taskLock = fake.calls.findIndex(sql => sql.includes("FOR UPDATE OF task"))
    const external = fake.calls.findIndex(sql => sql.includes('FROM "agent_events" AS started'))
    const update = fake.calls.findIndex(sql => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))
    expect(session).toBeLessThan(turn)
    expect(turn).toBeLessThan(taskLock)
    expect(taskLock).toBeLessThan(external)
    expect(external).toBeLessThan(update)
    const scan = fake.calls.find(sql => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1")) ?? ""
    expect(scan).toContain('task."leaseExpiresAt" <= clock_timestamp()')
    expect(scan).not.toContain('task."leaseExpiresAt" IS NULL')
  })

  it("keeps an expired lease as a blocker when a model or tool start has no terminal event", async () => {
    const fake = fixture({ pendingCall: true })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.at(-1)).toBe("COMMIT")
  })

  it("does not scan a task without an explicit lease expiry", async () => {
    const fake = fixture({ candidate: false })
    await expect(recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10 })).resolves.toEqual([])
    expect(fake.calls.some(sql => sql.includes("FOR UPDATE OF task"))).toBe(false)
  })

  it("bounds pause recovery to the exact Session and Turn", async () => {
    const fake = fixture()
    await recoverExpired(fake.pool as PgSubagentPool, { now: checkedAt, limit: 10, sessionId: "session-1", turnId: "turn-1" })
    const scan = fake.calls.find(sql => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1")) ?? ""
    expect(scan).toContain('task."sessionId" = $2')
    expect(scan).toContain('task."turnId" = $3')
    const scanCall = fake.client.query.mock.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1"))
    expect(scanCall?.[1]).toEqual([10, "session-1", "turn-1"])
  })
})
