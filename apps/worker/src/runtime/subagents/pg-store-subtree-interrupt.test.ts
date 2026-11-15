import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"

const mocks = vi.hoisted(() => ({
  appendInternalAcceptedInterrupt: vi.fn(),
  deleteGraphDispatch: vi.fn(),
  persistGraphTransition: vi.fn(),
  prepareGraphTransition: vi.fn(),
  reconcileGraphDependents: vi.fn(),
}))

vi.mock("./task-interrupt-outbox.js", () => ({ appendInternalAcceptedInterrupt: mocks.appendInternalAcceptedInterrupt }))
vi.mock("./task-graph-pg-lifecycle.js", () => ({
  deleteGraphDispatch: mocks.deleteGraphDispatch,
  persistGraphTransition: mocks.persistGraphTransition,
  prepareGraphTransition: mocks.prepareGraphTransition,
  reconcileGraphDependents: mocks.reconcileGraphDependents,
}))

import { interruptMatchingInSession } from "./pg-store-subtree-interrupt.js"

const now = new Date("2026-11-13T10:00:00.000Z")

function fakeClient(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.startsWith('SELECT task."id", task."status", task."attemptCount"')) return { rows, rowCount: rows.length }
    if (sql.startsWith('UPDATE "sub_agent_tasks"')) {
      return { rows: [{ interruptRequestedAt: now.toISOString() }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
}

beforeEach(() => vi.resetAllMocks())

describe("session-locked subtree interruption helper", () => {
  it("interrupts running descendants by signal and settles non-running descendants", async () => {
    const { client, query } = fakeClient([
      { id: "running-child", status: "running", attemptCount: 2, turnId: "turn-1" },
      { id: "waiting-grandchild", status: "waiting", attemptCount: 1, turnId: "turn-1" },
    ])
    const prepared = { scope: { sessionId: "session-1" } }
    mocks.prepareGraphTransition.mockResolvedValue(prepared)

    await expect(interruptMatchingInSession(client, {
      sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/parent-1",
    }, "user-1", now)).resolves.toBe(2)

    const selection = query.mock.calls[0]?.[0] ?? ""
    expect(selection).toContain('task."sessionId" = $1')
    expect(selection).toContain('task."rootTaskId" = $2')
    expect(selection).toContain('(task."path" = $3 OR left(task."path", char_length($3) + 1) = $3 || \'/\')')
    expect(selection).not.toContain('task."path" LIKE')
    expect(selection).toContain("'queued', 'running', 'retrying', 'waiting', 'waiting_for_user'")
    const updates = query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(updates).toHaveLength(2)
    expect(updates[0]?.[0]).toContain('"status" = \'running\'')
    expect(updates[0]?.[0]).toContain('"interruptRequestedAt" = COALESCE')
    expect(updates[1]?.[0]).toContain('"status" = \'interrupted\'')
    expect(updates[1]?.[0]).toContain('"nextAttemptAt" = NULL')
    expect(mocks.prepareGraphTransition).toHaveBeenCalledTimes(1)
    expect(mocks.prepareGraphTransition).toHaveBeenCalledWith(client, {
      taskId: "waiting-grandchild", sessionId: "session-1", type: "task.interrupted", attemptCount: 1,
    })
    expect(mocks.appendInternalAcceptedInterrupt).toHaveBeenCalledTimes(2)
    expect(mocks.appendInternalAcceptedInterrupt).toHaveBeenCalledWith(client, "user-1", {
      sessionId: "session-1", turnId: "turn-1", taskId: "running-child", interruptRequestedAt: now.toISOString(),
    })
    expect(mocks.deleteGraphDispatch).toHaveBeenCalledWith(client, "session-1", "waiting-grandchild")
    expect(mocks.persistGraphTransition).toHaveBeenCalledWith(client, prepared, now)
    expect(mocks.reconcileGraphDependents).toHaveBeenCalledWith(client, prepared.scope, now)
  })

  it("does not update a queued descendant when its graph transition is blocked", async () => {
    const { client, query } = fakeClient([
      { id: "queued-child", status: "queued", attemptCount: 0, turnId: "turn-1" },
    ])
    mocks.prepareGraphTransition.mockResolvedValue({ blocked: true })

    await expect(interruptMatchingInSession(client, {
      sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/parent-1",
    }, "user-1", now)).resolves.toBe(0)

    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(mocks.appendInternalAcceptedInterrupt).not.toHaveBeenCalled()
    expect(mocks.deleteGraphDispatch).not.toHaveBeenCalled()
  })

  it("treats percent and underscore in the target path literally and requires a slash boundary", async () => {
    const { client, query } = fakeClient([])
    const targetPath = "/root-1/parent_%_"

    await expect(interruptMatchingInSession(client, {
      sessionId: "session-1", rootTaskId: "root-1", targetPath,
    }, "user-1", now)).resolves.toBe(0)

    const [selection, params] = query.mock.calls[0] ?? [""]
    expect(selection).toContain('left(task."path", char_length($3) + 1) = $3 || \'/\'')
    expect(selection).not.toContain(" LIKE ")
    expect(params?.[2]).toBe(targetPath)
  })
})
