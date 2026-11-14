import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { PgSubagentPool } from "./types.js"

const mocks = vi.hoisted(() => ({
  interruptMatchingInSession: vi.fn(),
  persistGraphTransition: vi.fn(),
  prepareGraphTransition: vi.fn(),
  reconcileGraphDependents: vi.fn(),
}))

vi.mock("./pg-store-subtree-interrupt.js", () => ({ interruptMatchingInSession: mocks.interruptMatchingInSession }))
vi.mock("./task-graph-pg-lifecycle.js", () => ({
  persistGraphTransition: mocks.persistGraphTransition,
  prepareGraphTransition: mocks.prepareGraphTransition,
  reconcileGraphDependents: mocks.reconcileGraphDependents,
}))

import { closeSubagentTask } from "./pg-store-close.js"

const now = new Date("2026-11-13T10:00:00.000Z")

function closeFixture(options: { taskExists?: boolean } = {}) {
  const timeline: string[] = []
  const query = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
      return { rows: [{ userId: "user-1" }], rowCount: 1 }
    }
    if (sql.includes("set_config('app.user_id'")) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) {
      return options.taskExists === false ? { rows: [], rowCount: 0 } : {
        rows: [{ attemptCount: 3, rootTaskId: "root-1", path: "/root-1/parent-1" }], rowCount: 1,
      }
    }
    if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = \'closed\'')) {
      timeline.push("parent_closed")
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool
  return { client, pool, query, timeline }
}

beforeEach(() => vi.resetAllMocks())

describe("closing a subagent task", () => {
  it("closes the parent before interrupting its subtree in the same session transaction", async () => {
    const fixture = closeFixture()
    mocks.prepareGraphTransition.mockResolvedValue(null)
    mocks.interruptMatchingInSession.mockImplementation(async () => {
      fixture.timeline.push("subtree_interrupted")
      return 2
    })

    await expect(closeSubagentTask(fixture.pool, { taskId: "parent-1", sessionId: "session-1", now })).resolves.toBe(true)

    expect(fixture.timeline).toEqual(["parent_closed", "subtree_interrupted"])
    expect(mocks.interruptMatchingInSession).toHaveBeenCalledWith(fixture.client, {
      sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/parent-1",
    }, "user-1", now)
    expect(fixture.client.release).toHaveBeenCalledOnce()
  })

  it("does not start subtree interruption when the task cannot be closed", async () => {
    const fixture = closeFixture({ taskExists: false })
    mocks.prepareGraphTransition.mockResolvedValue(null)

    await expect(closeSubagentTask(fixture.pool, { taskId: "missing-parent", sessionId: "session-1", now })).resolves.toBe(false)

    expect(mocks.interruptMatchingInSession).not.toHaveBeenCalled()
    expect(fixture.timeline).toEqual([])
    expect(fixture.client.release).toHaveBeenCalledOnce()
  })
})
