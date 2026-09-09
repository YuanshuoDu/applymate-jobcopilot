import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import type pg from "pg"
import { dispatchPendingSubagentOutbox, enqueueSubagentTask, persistSubagentDispatch, startSubagentRecoveryScanner, subagentDispatchKey, subagentJobId } from "./subagent-queue.js"
import type { AgentTreeManager } from "../runtime/subagents/manager.js"
import type { SubagentJobPayload } from "../runtime/subagents/types.js"

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }

function fakePool(markError?: Error) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes('FROM "agent_outbox"')) return { rows: [{ id: "outbox-1", payload, attemptCount: 0 }], rowCount: 1 }
      if (markError && sql.startsWith('UPDATE "agent_outbox"')) throw markError
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool, calls }
}

describe("Subagent queue", () => {
  it("uses a strict payload and deterministic job id", async () => {
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await enqueueSubagentTask(queue, payload)
    expect(queue.add).toHaveBeenCalledWith("subagent", payload, { jobId: subagentJobId("task-1", 0), attempts: 3 })
    await expect(enqueueSubagentTask(queue, { ...payload, extra: true } as never)).rejects.toThrow("Invalid")
  })

  it("persists idempotent dispatch intent before queue delivery", async () => {
    const fake = fakePool()
    await persistSubagentDispatch(fake.pool, payload)
    expect(fake.calls.some(([sql]) => sql.includes("ON CONFLICT (\"idempotencyKey\") DO NOTHING"))).toBe(true)
    expect(fake.calls.some(([, params]) => params?.includes(subagentDispatchKey("task-1")))).toBe(true)
  })

  it("dispatches pending intents and marks them published only after queue add", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).resolves.toBe(1)
    expect(queue.add).toHaveBeenCalledWith("subagent", payload, { jobId: subagentJobId("task-1", 0), attempts: 3 })
    const mark = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))
    expect(mark?.[0]).toContain('"publishedAt"')
  })

  it("records queue_add_failed and preserves an unpublished row when Redis enqueue fails", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")) }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).rejects.toThrow("redis unavailable")
    const mark = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))
    expect(mark?.[0]).toContain('"publishedAt" = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE "publishedAt" END')
    expect(mark?.[1]).toEqual(["outbox-1", "queue_add_failed", false])
  })

  it("fails closed when enqueue succeeds but publication bookkeeping is uncertain", async () => {
    const fake = fakePool(new Error("database unavailable"))
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    await expect(dispatchPendingSubagentOutbox(fake.pool, queue)).rejects.toMatchObject({ code: "subagent_dispatch_delivery_uncertain", message: "subagent_dispatch_delivery_uncertain" })
    expect(queue.add).toHaveBeenCalledWith("subagent", payload, { jobId: subagentJobId("task-1", 0), attempts: 3 })
  })

  it("encodes task IDs and advances the generation after a recovered delivery", async () => {
    expect(subagentJobId("task:with spaces", 4)).toBe("agent-subagent-dGFzazp3aXRoIHNwYWNlcw-4")
    expect(subagentJobId("task:with spaces", 4)).not.toContain(":")
    const fake = fakePool()
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    const client = fake.pool.connect as ReturnType<typeof vi.fn>
    client.mockImplementation(async () => ({
      query: vi.fn(async (sql: string) => sql.includes('FROM "agent_outbox"') ? { rows: [{ id: "outbox-1", payload, attemptCount: 2 }], rowCount: 1 } : { rows: [], rowCount: 1 }),
      release: vi.fn(),
    }))
    await dispatchPendingSubagentOutbox(fake.pool, queue)
    expect(queue.add).toHaveBeenCalledWith("subagent", payload, { jobId: subagentJobId("task-1", 2), attempts: 3 })
  })

  it("runs one recovery scan immediately and can shut down cleanly", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockResolvedValue(undefined) }
    const manager = { recover: vi.fn().mockResolvedValue({ rows: [], reclaimed: 0, terminal: 0 }) } as unknown as AgentTreeManager
    const scanner = startSubagentRecoveryScanner(fake.pool, queue, manager, 60_000)
    await scanner.close()
    expect(manager.recover).toHaveBeenCalledTimes(1)
  })
})
