import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createCanonicalSessionProjection } from "./canonical-session-projection.js"

type Call = { readonly sql: string; readonly params?: readonly unknown[] }

function fakePool(options: { rowCount?: number | null; failOnUpdate?: boolean } = {}) {
  const calls: Call[] = []
  const client = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params })
      if (options.failOnUpdate && sql.startsWith("UPDATE")) throw new Error("session projection database unavailable")
      return { rows: [], rowCount: options.rowCount ?? 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client, calls }
}

const identity = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }

function update(fake: ReturnType<typeof fakePool>): Call {
  const call = fake.calls.find(item => item.sql.startsWith("UPDATE"))
  if (!call) throw new Error("missing update")
  return call
}

describe("canonical automation session projection", () => {
  it("uses tenant context and fences every mutation to the automation session and current Turn", async () => {
    const fake = fakePool()
    const projection = createCanonicalSessionProjection(fake.pool)

    await projection.start(identity)
    await projection.finish({ ...identity, result: { status: "completed" } })

    const updates = fake.calls.filter(call => call.sql.startsWith("UPDATE"))
    expect(updates).toHaveLength(2)
    for (const call of updates) {
      expect(call.sql).toContain('session."id" = $2')
      expect(call.sql).toContain('session."userId" = $1')
      expect(call.sql).toContain('automation_session."source" = \'automation\'')
      expect(call.sql).toContain('turn."id" = $3')
      expect(call.sql).toContain('turn."sessionId" = $2')
      expect(call.sql).toContain('turn."userId" = $1')
      expect(call.sql).toContain('turn."source" = \'automation\'')
      expect(call.sql).toContain('newer_turn."createdAt" > turn."createdAt"')
      expect(call.params?.slice(0, 3)).toEqual(["user-1", "session-1", "turn-1"])
    }
    expect(fake.calls.filter(call => call.sql.includes("set_config('app.user_id'"))).toHaveLength(2)
  })

  it("starts only a non-aborted automation session and clears completion", async () => {
    const fake = fakePool()
    await createCanonicalSessionProjection(fake.pool).start(identity)

    const call = update(fake)
    expect(call.sql).toContain('SET "status" = \'running\', "completedAt" = NULL')
    expect(call.sql).toContain('session."status" <> \'aborted\'')
    expect(call.sql).toContain('automation_session."source" = \'automation\'')
    expect(call.params).toEqual(["user-1", "session-1", "turn-1"])
  })

  it.each([
    ["completed", "completed", "failure-code"],
    ["failed", "failed", "failure-code"],
    ["waiting_for_dependency", "paused", "failure-code"],
    ["waiting_for_user", "waiting_for_user", "failure-code"],
    ["waiting_for_approval", "waiting_for_user", "failure-code"],
    ["interrupted", "paused", "failure-code"],
  ] as const)("maps %s to session status %s", async (turnStatus, expectedStatus, errorCode) => {
    const fake = fakePool()
    await createCanonicalSessionProjection(fake.pool).finish({ ...identity, result: { status: turnStatus, errorCode } })

    const call = update(fake)
    expect(call.params?.slice(0, 4)).toEqual(["user-1", "session-1", "turn-1", expectedStatus])
    expect(call.params?.[4]).toBe(expectedStatus === "failed" ? errorCode : null)
    expect(call.sql).toContain('"completedAt" = CASE WHEN $4 IN (\'completed\', \'failed\') THEN CURRENT_TIMESTAMP ELSE NULL END')
  })

  it("preserves cancelled, aborted, and terminal sessions through conditional status guards", async () => {
    const fake = fakePool({ rowCount: 0 })
    const projection = createCanonicalSessionProjection(fake.pool)

    await projection.start(identity)
    await projection.finish({ ...identity, result: { status: "completed" } })

    const updates = fake.calls.filter(call => call.sql.startsWith("UPDATE"))
    expect(updates[0]?.sql).toContain('session."status" <> \'aborted\'')
    expect(updates[1]?.sql).toContain(`session."status" IN ('queued', 'running', 'paused', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')`)
    expect(updates[1]?.sql).not.toContain("'cancelled'")
    expect(updates[1]?.sql).not.toContain("'aborted'")
    expect(fake.client.release).toHaveBeenCalledTimes(2)
  })

  it("excludes newer Turns from every session update regardless of their source", async () => {
    const fake = fakePool()
    await createCanonicalSessionProjection(fake.pool).finish({ ...identity, result: { status: "completed" } })

    const call = update(fake)
    expect(call.sql).toContain('newer_turn."sessionId" = turn."sessionId"')
    expect(call.sql).toContain('newer_turn."userId" = turn."userId"')
    expect(call.sql).toContain('newer_turn."id" > turn."id"')
    expect(call.sql).not.toContain('newer_turn."source"')
  })

  it("rejects missing and oversized identities before opening a transaction", async () => {
    const fake = fakePool()
    const projection = createCanonicalSessionProjection(fake.pool)

    await expect(projection.start({ ...identity, userId: "" })).rejects.toThrow("userId is invalid")
    await expect(projection.start({ ...identity, sessionId: "x".repeat(257) })).rejects.toThrow("sessionId is invalid")
    await expect(projection.finish({ ...identity, turnId: "💩".repeat(65), result: { status: "completed" } })).rejects.toThrow("turnId is invalid")
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })

  it("propagates projection failures and rolls back the transaction", async () => {
    const fake = fakePool({ failOnUpdate: true })

    await expect(createCanonicalSessionProjection(fake.pool).start(identity)).rejects.toThrow("session projection database unavailable")
    expect(fake.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(fake.client.release).toHaveBeenCalledTimes(1)
  })

  it("does not open a transaction for an unmapped Turn outcome", async () => {
    const fake = fakePool()

    await createCanonicalSessionProjection(fake.pool).finish({ ...identity, result: { status: "queued" as never } })
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })
})
