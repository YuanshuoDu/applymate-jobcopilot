import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TurnLease } from "./turns/lease.js"
import { loadApplicationFillPreparation } from "./application-fill-preparation.js"

type BoundRow = { id: string; userId: string; sessionId: string; fillTurnSessionId: string; fillTurnUserId: string; status: string; checkpoint: string }
const boundTask: BoundRow = {
  id: "application-a", userId: "user-a", sessionId: "session-a", fillTurnSessionId: "session-a", fillTurnUserId: "user-a",
  status: "filling", checkpoint: "taskgraph_fill_queued",
}

function fixture(boundRows: BoundRow[] = [boundTask], materialRows: Array<{ id: string }> = [{ id: "application-a" }]) {
  const lease: TurnLease = {
    turnId: "turn-a", sessionId: "session-a", userId: "user-a", ownerId: "worker-a", leaseVersion: 7,
    leaseStartedAt: new Date("2026-10-15T11:59:00.000Z"), leaseExpiresAt: new Date("2026-10-15T12:01:00.000Z"),
  }
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes("set_config")) return { rows: [{ set_config: "user-a" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: boundRows, rowCount: boundRows.length }
      if (sql.includes('FROM "application_tasks"')) return { rows: materialRows, rowCount: materialRows.length }
      throw new Error(`unexpected preparation query: ${sql}`)
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { lease, calls, client, pool }
}

describe("application-fill preparation", () => {
  it("confirms the live Turn lease and exact DB-bound queued ApplicationTask without exposing its identity", async () => {
    const test = fixture()
    const now = new Date("2026-10-15T12:00:00.000Z")

    await expect(loadApplicationFillPreparation(test.pool, test.lease, now)).resolves.toEqual({ available: true })

    const read = test.calls.find(call => call.sql.includes('FROM "agent_turns"'))
    expect(read?.sql).toContain('turn."userId" = $3')
    expect(read?.sql).toContain('turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5')
    expect(read?.sql).toContain('turn."leaseExpiresAt" > $6 AND turn."status" = \'in_progress\'')
    expect(read?.sql).toContain('app."fillTurnId" = turn."id"')
    expect(read?.values).toEqual(["turn-a", "session-a", "user-a", "worker-a", 7, now])
    const materials = test.calls.find(call => call.sql.includes('FROM "application_tasks"'))
    expect(materials?.sql).toContain('job."userId" = app."userId"')
    expect(materials?.sql).toContain('resume."userId" = app."userId"')
    expect(materials?.sql).toContain('(resume."targetJobId" IS NULL OR resume."targetJobId" = app."jobId")')
    expect(materials?.sql).toContain('cover."userId" = app."userId" AND cover."jobId" = app."jobId"')
    expect(materials?.sql).toContain('app."fillTurnSessionId" = $3 AND app."fillTurnUserId" = $2')
    expect(materials?.values).toEqual(["application-a", "user-a", "session-a", "turn-a"])
    expect(test.calls.map(call => call.sql)).toContain("COMMIT")
    expect(test.client.release).toHaveBeenCalledOnce()
  })

  it("withholds the capability when no exact bound ApplicationTask exists", async () => {
    const test = fixture([])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toBeUndefined()
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(true)
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("rejects a bound task outside the queued fill state instead of treating it as an ordinary Turn", async () => {
    const test = fixture([{ ...boundTask, status: "failed", checkpoint: "fill_prestart_failed" }])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).rejects.toThrow("application_fill_state_invalid")
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(false)
    expect(test.client.release).toHaveBeenCalledOnce()
  })

  it("rejects a bound fill with missing or mismatched persisted material", async () => {
    const test = fixture([boundTask], [])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).rejects.toThrow("application_fill_material_unavailable")
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(test.calls.some(call => call.sql === "COMMIT")).toBe(false)
    expect(test.client.release).toHaveBeenCalledOnce()
  })

  it("rejects a bound task whose persisted session/user bindings do not match the leased Turn", async () => {
    const test = fixture([{ ...boundTask, fillTurnUserId: "different-user" }])

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).rejects.toThrow("application_fill_binding_invalid")
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
  })

  it("does not query when the Turn lease fence is malformed", async () => {
    const test = fixture()
    test.lease.leaseVersion = 0

    await expect(loadApplicationFillPreparation(test.pool, test.lease)).resolves.toBeUndefined()
    expect(test.pool.connect).not.toHaveBeenCalled()
  })
})
