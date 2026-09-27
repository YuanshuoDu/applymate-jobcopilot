import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { enqueueReadyGraphTask } from "./task-graph-pg-dispatch.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const dispatchPayload = { taskId: "child-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "coordination-old" }

function fakeDispatchClient(options: { resetRowCount?: number; payload?: unknown } = {}) {
  const existing: { payload: unknown; publishedAt: Date | null } = {
    payload: options.payload ?? dispatchPayload,
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
  }
  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_outbox" WHERE "topic" = \'agent.subagent.dispatch\'')) return { rows: [existing], rowCount: 1 }
      if (sql.startsWith('UPDATE "agent_outbox" AS dispatch')) {
        if ((options.resetRowCount ?? 1) === 1) existing.publishedAt = null
        return { rows: [], rowCount: options.resetRowCount ?? 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  return { client, existing }
}

describe("enqueueReadyGraphTask", () => {
  it("resets an existing published dispatch under the child and tenant fences", async () => {
    const { client, existing } = fakeDispatchClient()

    await enqueueReadyGraphTask(client as unknown as Pick<pg.PoolClient, "query">, scope, "child-1")

    const reset = client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "agent_outbox" AS dispatch'))
    expect(reset).toBeDefined()
    expect(reset?.[0]).toContain('dispatch."publishedAt" IS NOT NULL')
    expect(reset?.[0]).toContain('task."status" = \'queued\'')
    expect(reset?.[0]).toContain('task."leaseOwner" IS NULL AND task."leaseExpiresAt" IS NULL')
    expect(reset?.[0]).toContain('task."interruptRequestedAt" IS NULL')
    expect(reset?.[0]).toContain('session."userId" = $6')
    expect(reset?.[1]).toEqual(["session-1", "subagent-dispatch:child-1", "child-1", "turn-1", "root-1", "user-1"])
    expect(existing.publishedAt).toBeNull()
  })

  it("fails closed when the scoped queued task no longer matches the dispatch fence", async () => {
    const { client, existing } = fakeDispatchClient({ resetRowCount: 0 })

    await expect(enqueueReadyGraphTask(client as unknown as Pick<pg.PoolClient, "query">, scope, "child-1"))
      .rejects.toThrow("task_graph_dispatch_reset_fenced")

    expect(existing.publishedAt).not.toBeNull()
  })

  it("rejects an existing dispatch payload for a different graph scope", async () => {
    const { client } = fakeDispatchClient({ payload: { ...dispatchPayload, rootTaskId: "other-root" } })

    await expect(enqueueReadyGraphTask(client as unknown as Pick<pg.PoolClient, "query">, scope, "child-1"))
      .rejects.toThrow("task_graph_dispatch_conflict")
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox" AS dispatch'))).toBe(false)
  })
})
