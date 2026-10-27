import { beforeEach, describe, expect, it, vi } from "vitest"

const lifecycle = vi.hoisted(() => ({ prepare: vi.fn(), persist: vi.fn(), reconcile: vi.fn() }))
vi.mock("./task-graph-pg-lifecycle.js", () => ({
  prepareGraphTransition: lifecycle.prepare,
  persistGraphTransition: lifecycle.persist,
  reconcileGraphDependents: lifecycle.reconcile,
}))

import { closeSubagentTask } from "./pg-store-close.js"

function database(options: { taskFound?: boolean; updateCount?: number } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ userId: "user-1" }], rowCount: 1 }
      if (sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT task."attemptCount"')) return options.taskFound === false
        ? { rows: [], rowCount: 0 } : { rows: [{ attemptCount: 2 }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rows: [], rowCount: options.updateCount ?? 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, calls, client }
}

describe("closeSubagentTask", () => {
  beforeEach(() => {
    lifecycle.prepare.mockReset().mockResolvedValue(null)
    lifecycle.persist.mockReset().mockResolvedValue(undefined)
    lifecycle.reconcile.mockReset().mockResolvedValue(undefined)
  })

  it("closes the task and clears its running segment while preserving its immutable deadline", async () => {
    const fake = database()
    await expect(closeSubagentTask(fake.pool as never, { taskId: "child-1", sessionId: "session-1", now: new Date() })).resolves.toBe(true)
    const update = fake.calls.find(call => call.sql.startsWith('UPDATE "sub_agent_tasks"'))?.sql ?? ""
    expect(update).toContain('"leaseSegmentStartedAt" = CASE WHEN "absoluteDeadlineAt" IS NOT NULL THEN NULL ELSE "leaseSegmentStartedAt" END')
    expect(update).not.toContain('"absoluteDeadlineAt" =')
    expect(update).toContain(`"status" = 'closed'`)
  })

  it("does not update a task that is missing or already terminal", async () => {
    const fake = database({ taskFound: false })
    await expect(closeSubagentTask(fake.pool as never, { taskId: "child-1", sessionId: "session-1", now: new Date() })).resolves.toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })
})
