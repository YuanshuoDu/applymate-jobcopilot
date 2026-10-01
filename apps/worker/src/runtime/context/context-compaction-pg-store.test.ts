import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { assertCompactionScope, withCompactionOwner, type CompactionPgClient, type CompactionPgPool } from "./context-compaction-pg-store.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-a", sessionId: "session-a", turnId: "turn-a", taskId: "root-a", rootTaskId: "root-a",
  ownerId: "worker-a", leaseVersion: 4, leaseExpiresAt: new Date(Date.now() + 60_000),
}

describe("context compaction PostgreSQL transaction helpers", () => {
  it("rejects a mismatched tenant before acquiring a connection", () => {
    const connect = vi.fn()
    expect(() => assertCompactionScope({ userId: "user-b" }, owner, owner.sessionId, owner.turnId)).toThrow("tenant or owner scope")
    expect(connect).not.toHaveBeenCalled()
  })

  it("rolls back and releases when the open-session lock is unavailable", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM "agent_sessions"') ? [] : [], rowCount: 0 }))
    const release = vi.fn()
    const client = { query, release } as unknown as CompactionPgClient
    const pool = { connect: vi.fn(async () => client) } as unknown as CompactionPgPool
    await expect(withCompactionOwner(pool, { userId: owner.userId }, owner, async () => "unused")).rejects.toThrow("open session")
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SELECT set_config($1, $2, true)", expect.stringContaining('FROM "agent_sessions"'), "ROLLBACK"])
    expect(release).toHaveBeenCalledOnce()
  })
})
