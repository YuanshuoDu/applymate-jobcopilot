import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { hasActiveSubagentDescendants } from "./pg-store-descendant-completion.js"

function client(pending: boolean) {
  const query = vi.fn().mockResolvedValue({ rows: [{ pending }], rowCount: 1 })
  return { query } as unknown as Pick<pg.PoolClient, "query"> & { query: typeof query }
}

describe("active subagent descendant completion guard", () => {
  it("checks every session-, Turn-, and root-bound descendant by parent identity", async () => {
    const db = client(true)
    await expect(hasActiveSubagentDescendants(db, {
      taskId: "parent-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
    })).resolves.toBe(true)

    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain("WITH RECURSIVE descendants")
    expect(sql).toContain('child."parentTaskId" = parent."id"')
    expect(sql).toContain('child."sessionId" = parent."sessionId"')
    expect(sql).toContain('child."turnId" = parent."turnId"')
    expect(sql).toContain('child."rootTaskId" = parent."rootTaskId"')
    expect(sql).toContain("'completed', 'failed', 'interrupted', 'cancelled', 'closed'")
    expect(params).toEqual(["parent-1", "session-1", "turn-1", "root-1"])
  })

  it("treats an empty descendant result as complete", async () => {
    await expect(hasActiveSubagentDescendants(client(false), {
      taskId: "parent-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
    })).resolves.toBe(false)
  })
})
