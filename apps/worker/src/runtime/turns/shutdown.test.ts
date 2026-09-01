import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import { TurnShutdownController, registerTurnShutdown } from "./shutdown.js"
import { TurnExecutionRegistry } from "./turn-queue.js"
import type { TurnLease } from "./lease.js"

const lease: TurnLease = {
  turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1", userId: "user_1", leaseVersion: 1,
  leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
}

function pool() {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => { calls.push(sql); return { rows: [], rowCount: 1 } }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, calls }
}

describe("Turn shutdown", () => {
  it("aborts active work, fences it as interrupted, and closes the queue", async () => {
    const fake = pool()
    const active = new TurnExecutionRegistry()
    const abort = vi.fn().mockResolvedValue(undefined)
    active.add({ lease, abort })
    const closeQueue = vi.fn().mockResolvedValue(undefined)
    const controller = new TurnShutdownController({ pool: fake.pool, active, closeQueue })
    await controller.shutdown("SIGTERM")
    expect(abort).toHaveBeenCalledOnce()
    expect(fake.calls.some((sql) => sql.includes('SET "status" = $5'))).toBe(true)
    expect(closeQueue).toHaveBeenCalledOnce()
  })

  it("is idempotent when SIGTERM and SIGINT arrive together", async () => {
    const fake = pool()
    const controller = new TurnShutdownController({ pool: fake.pool, active: new TurnExecutionRegistry(), closeQueue: vi.fn().mockResolvedValue(undefined) })
    await Promise.all([controller.shutdown("SIGTERM"), controller.shutdown("SIGINT")])
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })

  it("registers and unregisters both process signals", () => {
    const listeners = new Map<string, () => void>()
    const processLike = {
      on: vi.fn((signal: "SIGINT" | "SIGTERM", listener: () => void) => { listeners.set(signal, listener); return processLike }),
      off: vi.fn((signal: "SIGINT" | "SIGTERM") => { listeners.delete(signal); return processLike }),
    }
    const controller = new TurnShutdownController({ pool: pool().pool, active: new TurnExecutionRegistry(), closeQueue: vi.fn().mockResolvedValue(undefined) })
    const unregister = registerTurnShutdown(processLike, controller)
    expect(processLike.on).toHaveBeenCalledTimes(2)
    unregister()
    expect(processLike.off).toHaveBeenCalledTimes(2)
  })
})
