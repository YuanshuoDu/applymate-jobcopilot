import { describe, expect, it, vi } from "vitest"
import { recoverExpiredTaskGraphChildren } from "./pg-store-task-graph-deadline-recovery.js"

describe("TaskGraph deadline recovery scan", () => {
  it("rejects an unbounded or invalid scan before acquiring a connection", async () => {
    const connect = vi.fn()
    await expect(recoverExpiredTaskGraphChildren({ connect } as never, 0)).rejects.toThrow("limit must be positive")
    await expect(recoverExpiredTaskGraphChildren({ connect } as never, 1.5)).rejects.toThrow("limit must be positive")
    expect(connect).not.toHaveBeenCalled()
  })

  it("uses database clock, all active graph statuses, stable ordering, and the caller bound", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const client = { query, release: vi.fn() }
    const connect = vi.fn().mockResolvedValue(client)
    await expect(recoverExpiredTaskGraphChildren({ connect } as never, 17)).resolves.toEqual([])
    const scan = query.mock.calls.find(([sql]) => sql.includes('task."absoluteDeadlineAt" <= clock_timestamp()'))
    expect(scan?.[0]).toContain("'queued', 'running', 'retrying', 'waiting', 'waiting_for_user'")
    expect(scan?.[0]).toContain('ORDER BY task."absoluteDeadlineAt", task."sessionId", task."id" LIMIT $1')
    expect(scan?.[1]).toEqual([17])
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", expect.any(String), "COMMIT"])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it("revalidates each snapshotted candidate in its own Session-lock transaction", async () => {
    const candidates = ["child-a", "child-b"].map(id => ({
      id, sessionId: `session-${id}`, turnId: `turn-${id}`, rootTaskId: `root-${id}`, userId: `user-${id}`,
    }))
    const clients: Array<{ statements: string[]; release: ReturnType<typeof vi.fn> }> = []
    const connect = vi.fn(async () => {
      const statements: string[] = []
      const release = vi.fn()
      const query = vi.fn(async (sql: unknown) => {
        const statement = String(sql)
        statements.push(statement)
        return { rows: statement.includes('FROM "sub_agent_tasks" AS task') ? candidates : [], rowCount: 0 }
      })
      clients.push({ statements, release })
      return { query, release }
    })

    await expect(recoverExpiredTaskGraphChildren({ connect } as never, 2)).resolves.toEqual([])

    expect(connect).toHaveBeenCalledTimes(3)
    expect(clients.map(client => client.statements[0])).toEqual(["BEGIN", "BEGIN", "BEGIN"])
    expect(clients[0]?.statements[1]).toContain('task."absoluteDeadlineAt" <= clock_timestamp()')
    expect(clients.slice(1).map(client => client.statements[1])).toEqual([
      'SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE',
      'SELECT "userId", "status" FROM "agent_sessions" WHERE "id" = $1 FOR UPDATE',
    ])
    expect(clients.every(client => client.release.mock.calls.length === 1)).toBe(true)
  })
})
