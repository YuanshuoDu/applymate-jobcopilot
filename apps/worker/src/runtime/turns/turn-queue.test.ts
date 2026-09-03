import { describe, expect, it, vi } from "vitest"

vi.mock("ioredis", () => ({ Redis: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })) }))

import { runTurnJob, TurnExecutionRegistry } from "./turn-queue.js"
import type { TurnLease } from "./lease.js"
import { RootAbortControllerRegistry } from "../interrupt/registry.js"

const lease: TurnLease = {
  turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1", userId: "user_1", leaseVersion: 1,
  leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
}

function pool() {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => { calls.push(sql); return { rows: [{ ...lease, id: lease.turnId, leaseOwnerId: lease.ownerId }], rowCount: 1 } }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, calls }
}

describe("Turn queue processor", () => {
  it("does not execute a duplicate when the conditional lease claim loses", async () => {
    const fake = pool()
    const execute = vi.fn()
    const claimClient = fake.pool.connect as ReturnType<typeof vi.fn>
    claimClient.mockResolvedValueOnce({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn(),
    })
    await expect(runTurnJob({ data: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_2" }, attemptsMade: 0 }, { pool: fake.pool, execute })).resolves.toEqual({ status: "skipped", reasonCode: "lease_not_available" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("executes only after ownership and releases the lease on a terminal result", async () => {
    const fake = pool()
    const registry = new TurnExecutionRegistry()
    const execute = vi.fn().mockResolvedValue({ status: "completed" })
    const result = await runTurnJob({ data: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptsMade: 0 }, { pool: fake.pool, execute, active: registry })
    expect(result).toEqual({ status: "completed" })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ lease, signal: expect.any(AbortSignal) }))
    expect(registry.size).toBe(0)
    expect(fake.calls.some((sql) => sql.includes('SET "status" = $5'))).toBe(true)
  })

  it("records malformed payloads and never calls the executor", async () => {
    const fake = pool()
    const execute = vi.fn()
    const result = await runTurnJob({ data: { turnId: "turn_1", sessionId: "session_1", secret: "private" } as never, attemptsMade: 4 }, { pool: fake.pool, execute })
    expect(result).toEqual({ status: "dead_lettered", reasonCode: "schema_invalid_payload" })
    expect(execute).not.toHaveBeenCalled()
    expect(fake.calls.some((sql) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(true)
  })

  it("passes the shared root signal and returns interrupted without lease-loss requeue", async () => {
    const fake = pool()
    const interrupts = new RootAbortControllerRegistry()
    const execute = vi.fn(async ({ lease: current, signal }: { lease: TurnLease; signal: AbortSignal }) => {
      interrupts.stop({ userId: current.userId, sessionId: current.sessionId, turnId: current.turnId }, "user_stop")
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      return { status: "interrupted" as const }
    })
    const result = await runTurnJob(
      { data: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptsMade: 0 },
      { pool: fake.pool, execute, interrupts },
    )
    expect(result).toEqual({ status: "interrupted" })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(interrupts.size).toBe(0)
    expect(fake.calls.some((sql) => sql.includes('SET "status" = $5'))).toBe(true)
  })
})
