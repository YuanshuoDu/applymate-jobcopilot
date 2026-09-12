import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createCanonicalExecutionProjection } from "./canonical-execution-projection.js"

type Call = { readonly sql: string; readonly params?: readonly unknown[] }

function fakePool(options: { rowCount?: number | null; failOnUpdate?: boolean } = {}) {
  const calls: Call[] = []
  const client = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params })
      if (options.failOnUpdate && sql.startsWith("UPDATE")) throw new Error("projection database unavailable")
      return { rows: [], rowCount: options.rowCount ?? 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, calls }
}

const identity = { userId: "user-1", sessionId: "session-1" }

function update(fake: ReturnType<typeof fakePool>): Call {
  const call = fake.calls.find(item => item.sql.startsWith("UPDATE"))
  if (!call) throw new Error("missing update")
  return call
}

describe("canonical automation execution projection", () => {
  it("scopes every mutation to the user, session, and automation source", async () => {
    const fake = fakePool()
    const projection = createCanonicalExecutionProjection(fake.pool)

    await projection.start(identity)
    await projection.finish({ ...identity, result: { status: "completed" } })

    const updates = fake.calls.filter(call => call.sql.startsWith("UPDATE"))
    expect(updates).toHaveLength(2)
    for (const call of updates) {
      expect(call.sql).toContain('execution."userId" = $1')
      expect(call.sql).toContain('execution."sessionId" = $2')
      expect(call.sql).toContain('session."id" = $2')
      expect(call.sql).toContain('session."userId" = $1')
      expect(call.sql).toContain('session."source" = \'automation\'')
      expect(call.params?.slice(0, 2)).toEqual(["user-1", "session-1"])
    }
    expect(fake.calls.filter(call => call.sql.includes("set_config('app.user_id'"))).toHaveLength(2)
  })

  it("moves an active queued execution to running with a start timestamp", async () => {
    const fake = fakePool()
    await createCanonicalExecutionProjection(fake.pool).start(identity)

    const call = update(fake)
    expect(call.sql).toContain('SET "status" = \'running\'')
    expect(call.sql).toContain('SET "status" = \'running\', "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP)')
    expect(call.sql).toContain("IN ('queued', 'paused', 'waiting_for_user')")
  })

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["waiting_for_dependency", "paused"],
    ["waiting_for_user", "waiting_for_user"],
    ["waiting_for_approval", "waiting_for_user"],
    ["interrupted", "paused"],
  ] as const)("maps %s to the control status %s", async (turnStatus, expectedStatus) => {
    const fake = fakePool()
    await createCanonicalExecutionProjection(fake.pool).finish({ ...identity, result: { status: turnStatus, errorCode: "turn_error" } })

    const call = update(fake)
    expect(call.params?.slice(0, 3)).toEqual(["user-1", "session-1", expectedStatus])
    if (expectedStatus === "failed") expect(call.params?.[3]).toBe("turn_error")
    else expect(call.params?.[3]).toBeNull()
  })

  it("preserves cancelled and terminal rows through conditional SQL", async () => {
    const fake = fakePool({ rowCount: 0 })
    const projection = createCanonicalExecutionProjection(fake.pool)

    await projection.start(identity)
    await projection.finish({ ...identity, result: { status: "completed" } })

    const updates = fake.calls.filter(call => call.sql.startsWith("UPDATE"))
    expect(updates[0]?.sql).toContain("IN ('queued', 'paused', 'waiting_for_user')")
    expect(updates[1]?.sql).toContain("IN ('queued', 'running', 'paused', 'waiting_for_user')")
    expect(updates[1]?.sql).not.toContain("'cancelled'")
    expect(fake.client.release).toHaveBeenCalledTimes(2)
  })

  it("leaves a missing execution as a successful no-op", async () => {
    const fake = fakePool({ rowCount: 0 })
    await expect(createCanonicalExecutionProjection(fake.pool).finish({ ...identity, result: { status: "failed" } })).resolves.toBeUndefined()
  })

  it("propagates projection failures and rolls back the transaction", async () => {
    const fake = fakePool({ failOnUpdate: true })
    await expect(createCanonicalExecutionProjection(fake.pool).start(identity)).rejects.toThrow("projection database unavailable")
    expect(fake.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(fake.client.release).toHaveBeenCalledTimes(1)
  })

  it("does not open a transaction for a queued or otherwise unmapped outcome", async () => {
    const fake = fakePool()
    await createCanonicalExecutionProjection(fake.pool).finish({ ...identity, result: { status: "queued" as never } })
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })
})
