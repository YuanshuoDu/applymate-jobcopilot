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

function waitingPool() {
  const state = { turnStatus: "queued", leaseOwnerId: null as string | null, leaseVersion: 0 }
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql)
      if (sql.includes(`SET "status" = 'in_progress'`)) {
        state.turnStatus = "in_progress"
        state.leaseOwnerId = String(params?.[2])
        state.leaseVersion = 1
        return { rows: [{ ...lease, id: lease.turnId, leaseOwnerId: state.leaseOwnerId, leaseVersion: state.leaseVersion }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_outbox"')) return { rows: [], rowCount: 1 }
      if (sql.includes('SET "status" = $5')) {
        const next = String(params?.[4])
        const allowed = state.turnStatus === "in_progress" || (state.turnStatus === "waiting_for_user" && next === "waiting_for_user")
        if (!allowed || state.leaseOwnerId !== params?.[2] || state.leaseVersion !== params?.[3]) return { rows: [], rowCount: 0 }
        state.turnStatus = next
        state.leaseOwnerId = null
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, calls, state, persistWait: () => { state.turnStatus = "waiting_for_user" } }
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

  it("releases the turn after canonical runtime persists a user wait", async () => {
    const fake = waitingPool()
    const execute = vi.fn(async () => {
      fake.persistWait()
      return { status: "waiting_for_user" as const }
    })
    const result = await runTurnJob(
      { data: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptsMade: 0 },
      { pool: fake.pool, execute },
    )
    expect(result).toEqual({ status: "waiting_for_user" })
    expect(fake.state).toEqual({ turnStatus: "waiting_for_user", leaseOwnerId: null, leaseVersion: 1 })
    expect(fake.calls.some((sql) => sql.includes('"status" = \'in_progress\' OR ("status" = \'waiting_for_user\' AND $5 = \'waiting_for_user\')'))).toBe(true)
  })

  it("fences duplicate concurrent delivery before either executor can run twice", async () => {
    let claimed = false
    const clients = [] as Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>
    const concurrentPool = {
      connect: vi.fn(async () => {
        const client = {
          query: vi.fn(async (sql: string) => {
            if (sql.includes(`SET "status" = 'in_progress'`)) {
              if (claimed) return { rows: [], rowCount: 0 }
              claimed = true
              return { rows: [{ ...lease, id: lease.turnId, leaseOwnerId: lease.ownerId }], rowCount: 1 }
            }
            return { rows: [], rowCount: 1 }
          }),
          release: vi.fn(),
        }
        clients.push(client)
        return client
      }),
    }
    const execute = vi.fn(async () => ({ status: "completed" as const }))

    const results = await Promise.all([
      runTurnJob({ data: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptsMade: 0 }, { pool: concurrentPool as never, execute }),
      runTurnJob({ data: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_2" }, attemptsMade: 0 }, { pool: concurrentPool as never, execute }),
    ])

    expect(results).toContainEqual({ status: "skipped", reasonCode: "lease_not_available" })
    expect(results).toContainEqual({ status: "completed" })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(clients).toHaveLength(4)
  })

  it("releases a claimed Turn when dispatch bookkeeping fails", async () => {
    const fake = pool()
    const connect = fake.pool.connect as ReturnType<typeof vi.fn>
    const bookkeepingError = new Error("outbox update failed")
    const claimClient = {
      query: vi.fn(async (sql: string) => {
        fake.calls.push(sql)
        return { rows: [{ ...lease, id: lease.turnId, leaseOwnerId: lease.ownerId }], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const bookkeepingClient = {
      query: vi.fn(async () => { throw bookkeepingError }),
      release: vi.fn(),
    }
    connect.mockResolvedValueOnce(claimClient).mockResolvedValueOnce(bookkeepingClient)
    const execute = vi.fn()

    await expect(runTurnJob(
      { data: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptsMade: 0 },
      { pool: fake.pool, execute },
    )).rejects.toBe(bookkeepingError)

    expect(execute).not.toHaveBeenCalled()
    expect(bookkeepingClient.release).toHaveBeenCalledOnce()
    expect(fake.calls.some((sql) => sql.includes('SET "status" = $5'))).toBe(true)
  })

  it("uses the atomic wait handoff before ordinary lease release", async () => {
    const fake = pool()
    const execute = vi.fn().mockResolvedValue({ status: "waiting_for_dependency", waitId: "wait-1" })
    const waitHandoff = vi.fn().mockResolvedValue({ handoff: "suspended" })
    const result = await runTurnJob(
      { data: { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }, attemptsMade: 0 },
      { pool: fake.pool, execute, waitHandoff, now: () => new Date("2026-09-01T00:00:30.000Z") },
    )
    expect(result).toEqual({ status: "waiting_for_dependency", waitId: "wait-1" })
    expect(waitHandoff).toHaveBeenCalledWith(expect.objectContaining({ waitId: "wait-1", lease }))
    expect(fake.calls.some((sql) => sql.includes('SET "status" = $5'))).toBe(false)
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
