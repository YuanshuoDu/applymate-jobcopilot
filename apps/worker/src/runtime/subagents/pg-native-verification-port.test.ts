import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { createPgNativeVerificationPort } from "./pg-native-verification-port.js"
import type { PgSubagentPool } from "./types.js"

const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1,
  parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
}

describe("PostgreSQL native verification port", () => {
  it("preserves the session ownership fence and rolls back the same transaction", async () => {
    const query = vi.fn(async (sql: string) => sql === "BEGIN" || sql === "ROLLBACK" || sql.includes("set_config")
      ? { rows: [], rowCount: 0 }
      : { rows: [], rowCount: 0 })
    const release = vi.fn()
    const client = { query, release } as unknown as pg.PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as PgSubagentPool
    await expect(createPgNativeVerificationPort(pool).ensureChildren(scope)).rejects.toThrow("task_graph_session_fenced")
    expect(query.mock.calls.map(call => call[0])).toEqual([
      "BEGIN", expect.stringContaining("set_config"), expect.stringContaining('FROM "agent_sessions"'), "ROLLBACK",
    ])
    expect(release).toHaveBeenCalledOnce()
  })
})
