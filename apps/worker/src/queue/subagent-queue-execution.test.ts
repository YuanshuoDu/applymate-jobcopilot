import { describe, expect, it, vi } from "vitest"
import type { PgSubagentPool } from "../runtime/subagents/types.js"
import { repairMissingSubagentDispatches, subagentDispatchKey } from "./subagent-queue-execution.js"

describe("missing subagent dispatch repair", () => {
  it("locks runnable sessions and inserts a revalidated, idempotent dispatch", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
        if (sql.includes('FROM "agent_sessions" AS session') && sql.includes("LIMIT $2 FOR UPDATE SKIP LOCKED")) {
          return { rows: [{ id: "session-1" }], rowCount: 1 }
        }
        if (sql.includes('SELECT task."id", task."sessionId", task."rootTaskId", task."turnId"')) return { rows: [], rowCount: 0 }
        if (sql.includes("LIMIT $3 FOR UPDATE OF task SKIP LOCKED")) {
          return { rows: [{ id: "task-1", sessionId: "session-1", rootTaskId: "root-1" }], rowCount: 1 }
        }
        if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
        throw new Error("unexpected repair query")
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool

    await expect(repairMissingSubagentDispatches(pool, "repair-worker", 1)).resolves.toBe(1)

    const scan = calls.find(([sql]) => sql.includes("LIMIT $3 FOR UPDATE OF task SKIP LOCKED"))
    const insert = calls.find(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))
    expect(calls[1]?.[0]).toContain("FOR UPDATE SKIP LOCKED")
    expect(calls.indexOf(scan!)).toBeGreaterThan(1)
    expect(scan?.[0]).toContain('task."interruptRequestedAt" IS NULL')
    expect(scan?.[0]).toContain('root."status" NOT IN')
    expect(insert?.[0]).toContain("WHERE EXISTS")
    expect(insert?.[0]).toContain('task."status" IN (\'queued\', \'retrying\')')
    expect(insert?.[0]).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING')
    expect(insert?.[1]?.slice(1, 5)).toEqual([
      "agent.subagent.dispatch", "session-1", subagentDispatchKey("task-1"),
      JSON.stringify({ taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "repair-worker" }),
    ])
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
