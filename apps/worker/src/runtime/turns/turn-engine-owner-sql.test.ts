import { describe, expect, it } from "vitest"

import { ownerFenceSql, turnEngineTenantTransaction, type TurnEnginePool } from "./turn-engine-owner-sql.js"

const common = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", ownerId: "worker-1", leaseExpiresAt: new Date("2026-09-08T00:01:00Z") }

describe("turn owner SQL fence", () => {
  it("allows a current root lease to settle while waiting only when requested", () => {
    const owner = { ...common, kind: "turn" as const, taskId: "root-1", leaseVersion: 2 }
    expect(ownerFenceSql(owner, 1).where).toContain("= 'in_progress'")
    expect(ownerFenceSql(owner, 1, true).where).toContain("IN ('in_progress', 'waiting_for_user')")
  })

  it("requires child attempt, owner, live lease, interruption clear, and nonterminal root", () => {
    const owner = { ...common, kind: "task" as const, taskId: "child-1", ownerId: "child-worker", attemptCount: 3 }
    const fence = ownerFenceSql(owner, 1)
    expect(fence.joins).toContain('owner_task."rootTaskId" = $5')
    expect(fence.where).toContain('owner_task."attemptCount" = $7')
    expect(fence.where).toContain('owner_task."leaseExpiresAt" > CURRENT_TIMESTAMP')
    expect(fence.where).toContain('owner_task."interruptRequestedAt" IS NULL')
    expect(fence.where).toContain("root_task.\"status\" NOT IN")
  })

  it("sets tenant scope on the borrowed client and rolls back failed work", async () => {
    const calls: { sql: string; values?: readonly unknown[] }[] = []
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => { calls.push({ sql, values }); return { rows: [], rowCount: 1 } },
      release: () => undefined,
    }
    const pool = { connect: async () => client } as unknown as TurnEnginePool
    const failure = new Error("work failed")
    await expect(turnEngineTenantTransaction(pool, "user-1", async borrowed => {
      expect(borrowed).toBe(client)
      throw failure
    })).rejects.toBe(failure)
    expect(calls.map(call => call.sql)).toEqual(["BEGIN", "SELECT set_config($1, $2, true)", "ROLLBACK"])
    expect(calls[1]?.values).toEqual(["app.user_id", "user-1"])
  })
})
