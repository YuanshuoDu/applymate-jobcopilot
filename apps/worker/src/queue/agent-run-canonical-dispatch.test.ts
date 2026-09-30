import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import { createAgentRunCanonicalProducer } from "./agent-run-canonical-dispatch.js"
import { turnJobId } from "../runtime/turns/recovery-scanner.js"

function fakePool(lineageExists = true) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('WHERE turn."id" = $1') && sql.includes("FOR UPDATE OF turn, session")) {
        return lineageExists ? { rows: [{ id: "turn-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, calls }
}

describe("agent run canonical producer", () => {
  it("persists and enqueues a strict, execution-independent canonical payload", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }
    const producer = createAgentRunCanonicalProducer({ pool: fake.pool, queue })

    await producer.enqueue({ sessionId: "session-1", turnId: "turn:1" })

    expect(queue.add).toHaveBeenCalledWith(
      "turn",
      { turnId: "turn:1", sessionId: "session-1", ownerId: "agent-run:turn:1" },
      { jobId: turnJobId("turn:1"), attempts: 5 },
    )
    expect(queue.add.mock.calls[0]?.[1]).not.toHaveProperty("executionId")
    expect(fake.calls.some(({ sql }) => sql.includes('ON CONFLICT ("idempotencyKey") DO NOTHING'))).toBe(true)
  })

  it("reuses the outbox key and BullMQ job identity on repeated delivery", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }
    const producer = createAgentRunCanonicalProducer({ pool: fake.pool, queue })

    await producer.enqueue({ sessionId: "session-1", turnId: "turn-1" })
    await producer.enqueue({ sessionId: "session-1", turnId: "turn-1" })

    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1])
    expect(fake.calls.filter(({ sql }) => sql.includes('"idempotencyKey"')).length).toBe(2)
  })

  it("propagates queue failure so the agent-runs retry can recover", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis unavailable")), close: vi.fn().mockResolvedValue(undefined) }
    const producer = createAgentRunCanonicalProducer({ pool: fake.pool, queue })

    await expect(producer.enqueue({ sessionId: "session-1", turnId: "turn-1" })).rejects.toThrow("redis unavailable")
    expect(fake.calls.some(({ sql }) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(true)
  })

  it("rejects a canonical request whose Turn is outside the supplied session", async () => {
    const fake = fakePool(false)
    const queue = { add: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
    const producer = createAgentRunCanonicalProducer({ pool: fake.pool, queue })

    await expect(producer.enqueue({ sessionId: "session-1", turnId: "turn-1" })).rejects.toThrow("turn_dispatch_lineage_mismatch")
    expect(queue.add).not.toHaveBeenCalled()
    expect(fake.calls.some(({ sql }) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("closes its injected queue once and does not create a worker", async () => {
    const fake = fakePool()
    const queue = { add: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
    const producer = createAgentRunCanonicalProducer({ pool: fake.pool, queue })

    await producer.close()
    await producer.close()

    expect(queue.close).toHaveBeenCalledTimes(1)
  })
})
