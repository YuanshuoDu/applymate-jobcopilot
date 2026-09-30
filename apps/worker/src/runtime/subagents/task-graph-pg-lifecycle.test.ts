import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { prepareGraphTransition } from "./task-graph-pg-lifecycle.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "./task-graph-snapshot.js"

function fakeGraphClient(status: string, options: { proposalPayloads?: unknown[]; snapshot?: unknown; missingItem?: boolean } = {}) {
  const snapshot = options.snapshot ?? { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
    key: "child", templateId: "analyst", goal: "Inspect", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "child-1",
  }] }
  const proposalPayloads = options.proposalPayloads ?? [{ kind: "proposal", receipt: {
    revision: 2, nodes: [{ key: "child", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
  } }]
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: proposalPayloads.map(payload => ({ payload })), rowCount: proposalPayloads.length }
      if (sql.includes('SELECT item."id"')) return options.missingItem ? { rows: [], rowCount: 0 } : { rows: [{
        id: taskGraphItemId("root-1"), revision: 2, content: snapshot, createdAt: new Date("2026-09-01T00:00:00.000Z"),
      }], rowCount: 1 }
      if (sql.includes('SELECT task."id", task."status"')) {
        const ids = params?.[0] as string[]
        return { rows: ids.map(id => ({ id, status, role: "analyst", failureReason: null, result: null })), rowCount: ids.length }
      }
      if (sql.includes('SELECT event."payload"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    }),
  }
  return client
}

describe("prepareGraphTransition", () => {
  it("reduces a lifecycle receipt from the current persisted status and revision", async () => {
    const client = fakeGraphClient("running")
    const transition = await prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.completed", attemptCount: 1,
    })
    if (!transition || "blocked" in transition) throw new Error("expected prepared graph transition")

    expect(transition).toMatchObject({ expectedRevision: 2, state: { revision: 3, nodes: [{ key: "child", status: "completed" }] }, duplicate: false })
    expect(transition?.event).toMatchObject({ type: "task.completed", expectedRevision: 2, nodeKey: "child" })
  })

  it("sanitizes failure details before the reducer receipt is prepared", async () => {
    const client = fakeGraphClient("running")
    const transition = await prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.failed", attemptCount: 1,
      failureReason: "authorization: Bearer abcdefghijklmnop user@example.com",
    })
    if (!transition || "blocked" in transition) throw new Error("expected prepared graph transition")

    expect(transition?.event.type).toBe("task.failed")
    if (transition?.event.type !== "task.failed") throw new Error("expected task.failed event")
    expect(transition.event.failureReason).not.toContain("abcdefghijklmnop")
    expect(transition.event.failureReason).not.toContain("user@example.com")
  })

  it("fails closed for a persisted graph child when its item is missing", async () => {
    const client = fakeGraphClient("queued", { missingItem: true })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.started",
    })).rejects.toThrow("task_graph_state_missing")
    const membership = client.query.mock.calls.find(([sql]) => sql.includes("event.\"payload\"->>'kind' = 'proposal'"))
    expect(membership?.[0]).toContain('event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4')
    expect(membership?.[0]).toContain('session."userId" = $5 AND turn."userId" = $5')
    expect(membership?.[1]).toEqual(["session-1", "turn-1", taskGraphItemId("root-1"), "root-1", "user-1"])
    expect(client.query.mock.calls.every(([sql]) => sql.trimStart().startsWith("SELECT"))).toBe(true)
  })

  it("fails closed when a persisted graph child has a corrupt snapshot", async () => {
    const client = fakeGraphClient("queued", { snapshot: { schemaVersion: "invalid", nodes: [] } })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.started",
    })).rejects.toThrow("task_graph_snapshot_invalid")
  })

  it("fails closed when a persisted graph child is absent from a valid snapshot", async () => {
    const client = fakeGraphClient("queued", { snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
      key: "other", templateId: "analyst", goal: "Inspect", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "other-child",
    }] } })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.started",
    })).rejects.toThrow("task_graph_child_missing")
  })

  it("fails closed for an unreadable proposal receipt instead of treating it as a legacy child", async () => {
    const client = fakeGraphClient("queued", { proposalPayloads: [{ kind: "proposal", receipt: { revision: 2, nodes: "invalid", readyTaskIds: [] } }] })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "legacy-child", sessionId: "session-1", type: "task.started",
    })).rejects.toThrow("task_graph_receipt_invalid")
    expect(client.query.mock.calls.some(([sql]) => sql.includes('SELECT item."id"'))).toBe(false)
  })

  it("keeps a same-root child on the legacy path when no proposal receipt contains it", async () => {
    const client = fakeGraphClient("queued", { proposalPayloads: [] })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "legacy-child", sessionId: "session-1", type: "task.started",
    })).resolves.toBeNull()
    expect(client.query.mock.calls.some(([sql]) => sql.includes('SELECT item."id"'))).toBe(false)
  })
})
