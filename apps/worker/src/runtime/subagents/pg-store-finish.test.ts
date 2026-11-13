import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { finishSubagentTask } from "./pg-store-finish.js"
import type { PgSubagentPool } from "./types.js"

const mocks = vi.hoisted(() => ({
  prepareTaskGraphFinish: vi.fn(),
  hasActiveSubagentDescendants: vi.fn(),
  interruptMatchingInSession: vi.fn(),
  taskGraphDeadlineLive: vi.fn(),
  lockScheduledGateFinish: vi.fn(),
}))

vi.mock("./pg-store-lifecycle.js", () => ({ prepareTaskGraphFinish: mocks.prepareTaskGraphFinish }))
vi.mock("./pg-store-descendant-completion.js", () => ({ hasActiveSubagentDescendants: mocks.hasActiveSubagentDescendants }))
vi.mock("./pg-store-subtree-interrupt.js", () => ({ interruptMatchingInSession: mocks.interruptMatchingInSession }))
vi.mock("./pg-store-claim.js", () => ({ taskGraphDeadlineLive: mocks.taskGraphDeadlineLive }))
vi.mock("./pg-store-gate-finish.js", () => ({ lockScheduledGateFinish: mocks.lockScheduledGateFinish }))

const now = new Date("2026-11-13T10:00:00.000Z")
const liveTask = {
  id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", path: "/root-1/parent-1", taskType: "job_discovery", role: "scout",
  status: "running", leaseOwner: "worker-1", attemptCount: 1, maxAttempts: 3,
  leaseExpiresAt: new Date("2026-11-13T10:01:00.000Z"), absoluteDeadlineAt: null,
  interruptRequestedAt: null, result: null, failureReason: null,
}

function fakePool(taskRows: readonly Record<string, unknown>[] = [liveTask]) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.startsWith('SELECT "id", "userId", "status" FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT task.*, session."userId" AS "userId"')) return { rows: taskRows, rowCount: taskRows.length }
      if (sql.startsWith('SELECT clock_timestamp() AS "checkedAt"')) return { rows: [{ checkedAt: now }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool, client, calls }
}

function input(overrides: Record<string, unknown> = {}) {
  return { taskId: "parent-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
    status: "completed" as const, result: { ok: true }, now, ...overrides }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.prepareTaskGraphFinish.mockImplementation(async (_client: pg.PoolClient, value: { status: string; result: unknown }) => ({
    graph: null, status: value.status, result: value.result,
  }))
  mocks.hasActiveSubagentDescendants.mockResolvedValue(false)
  mocks.interruptMatchingInSession.mockResolvedValue(0)
  mocks.taskGraphDeadlineLive.mockResolvedValue(true)
  mocks.lockScheduledGateFinish.mockResolvedValue(true)
})

describe("parent finish with descendants", () => {
  it("returns typed children-pending before any completion or mailbox writes", async () => {
    const db = fakePool()
    mocks.hasActiveSubagentDescendants.mockImplementation(async (client: Pick<pg.PoolClient, "query">) => {
      await client.query("WITH RECURSIVE descendants", [])
      return true
    })

    await expect(finishSubagentTask(db.pool, input())).resolves.toEqual({ status: "children_pending" })

    const sql = db.calls.map(([statement]) => statement)
    const taskLock = sql.findIndex(statement => statement.includes("FOR UPDATE OF task"))
    const clock = sql.findIndex(statement => statement.startsWith('SELECT clock_timestamp() AS "checkedAt"'))
    const barrier = sql.findIndex(statement => statement.includes("WITH RECURSIVE descendants"))
    expect(taskLock).toBeGreaterThan(-1)
    expect(clock).toBeGreaterThan(taskLock)
    expect(barrier).toBeGreaterThan(clock)
    expect(sql.some(statement => statement.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(sql.some(statement => statement.includes('UPDATE "agent_mailbox_messages"') || statement.includes('INSERT INTO "agent_events"'))).toBe(false)
    expect(mocks.interruptMatchingInSession).not.toHaveBeenCalled()
    expect(db.client.release).toHaveBeenCalledOnce()
  })

  it("keeps stale lease loss distinct from a valid descendant wait", async () => {
    const stale = { ...liveTask, leaseOwner: "new-owner" }
    const db = fakePool([stale])

    await expect(finishSubagentTask(db.pool, input())).resolves.toBeNull()
    expect(mocks.hasActiveSubagentDescendants).not.toHaveBeenCalled()
  })

  it("interrupts descendants in the same transaction after a terminal failure", async () => {
    const db = fakePool()
    mocks.prepareTaskGraphFinish.mockResolvedValue({ graph: null, status: "failed", failureReason: "unverified", result: null })

    await expect(finishSubagentTask(db.pool, input())).resolves.toBe("failed")

    const updateIndex = db.calls.findIndex(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(updateIndex).toBeGreaterThan(-1)
    expect(mocks.interruptMatchingInSession).toHaveBeenCalledWith(db.client, {
      sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/parent-1",
    }, "user-1", now)
    expect(db.calls.at(-1)?.[0]).toBe("COMMIT")
  })

  it("preserves descendants when a retryable failure is queued", async () => {
    const db = fakePool()

    await expect(finishSubagentTask(db.pool, input({ status: "failed", retryDisposition: "retryable" }))).resolves.toBe("retrying")

    expect(mocks.hasActiveSubagentDescendants).not.toHaveBeenCalled()
    expect(mocks.interruptMatchingInSession).not.toHaveBeenCalled()
  })
})
