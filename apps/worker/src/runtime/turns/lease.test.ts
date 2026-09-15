import { describe, expect, it, vi } from "vitest"

import {
  claimTurnLease,
  expireTurnLease,
  interruptTurnLease,
  releaseTurnLease,
  renewTurnLease,
  TurnLeaseError,
  TURN_MAX_LEASE_MS,
  type LeasePool,
  type TurnLease,
} from "./lease.js"

const now = new Date("2026-09-01T00:00:00.000Z")
const row = {
  id: "turn_1", sessionId: "session_1", userId: "user_1", leaseOwnerId: "owner_1", leaseVersion: 8,
  leaseStartedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000),
}

function fakePool(rows: unknown[] = [row], sessionStatus = "running", sessionUserId = "user_1", controlGate = "open") {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql.includes('SELECT session."userId"')) {
        return ["missing", "aborted", "archived"].includes(sessionStatus) ? { rows: [], rowCount: 0 } : { rows: [{ userId: sessionUserId, controlGate }], rowCount: 1 }
      }
      if (sql.includes('SELECT session."id" FROM "agent_sessions"')) {
        return ["missing", "aborted", "archived"].includes(sessionStatus) ? { rows: [], rowCount: 0 } : { rows: [{ id: "session_1" }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns"') && ["missing", "aborted", "archived"].includes(sessionStatus)) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE "agent_turns"') && sessionUserId !== "user_1") return { rows: [], rowCount: 0 }
      return { rows, rowCount: rows.length }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, client, calls }
}

const payload = { turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1" }

describe("database Turn lease", () => {
  it("claims through one conditional UPDATE and returns a fencing token", async () => {
    const fake = fakePool()
    const result = await claimTurnLease(fake.pool, payload, now)
    expect(result).toMatchObject({ ...payload, userId: "user_1", leaseVersion: 8 })
    expect(fake.calls.filter(([sql]) => sql.includes('UPDATE "agent_turns"')).length).toBe(1)
    expect(fake.calls.find(([sql]) => sql.includes('UPDATE "agent_turns"'))?.[0]).toContain("status\" = 'queued'")
    expect(fake.calls.find(([sql]) => sql.includes('SELECT session."userId"'))?.[0]).toContain("status\" NOT IN ('aborted', 'archived')")
    expect(fake.calls.find(([sql]) => sql.includes('SELECT session."userId"'))?.[0]).toContain('session."controlGate" = \'open\'')
    expect(fake.calls.find(([sql]) => sql.includes('SELECT session."userId"'))?.[0]).toContain("FOR UPDATE")
    expect(fake.calls.find(([sql]) => sql.includes('UPDATE "agent_turns"'))?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(fake.calls.find(([sql]) => sql.includes('UPDATE "agent_turns"'))?.[0]).toContain('session."controlGate" = \'open\'')
    expect(fake.calls[0][0]).toBe("BEGIN")
    expect(fake.calls.findIndex(([sql]) => sql.includes('SELECT session."userId"'))).toBeLessThan(fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_turns"')))
  })

  it.each(["missing", "aborted", "archived"])("does not claim a Turn whose session is %s", async (sessionStatus) => {
    const fake = fakePool([row], sessionStatus)

    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available", recoverable: true })
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
  })

  it("does not claim a Turn across a session owner boundary", async () => {
    const fake = fakePool([row], "running", "user-2")

    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available" })
    expect(fake.calls.some(([sql]) => sql.includes('SELECT session."userId"'))).toBe(true)
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
  })

  it.each(["running", "paused", "waiting_for_user"])("claims a Turn when its ordinary session is %s", async (sessionStatus) => {
    const fake = fakePool([row], sessionStatus)

    await expect(claimTurnLease(fake.pool, payload, now)).resolves.toMatchObject({ turnId: payload.turnId, sessionId: payload.sessionId, userId: row.userId })
    const sql = fake.calls.find(([text]) => text.includes('UPDATE "agent_turns"'))?.[0] ?? ""
    expect(sql).not.toContain('session."source"')
  })

  it("does not claim a Turn when the user control gate is paused", async () => {
    const fake = fakePool([row], "running", "user_1", "user_paused")

    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available", recoverable: true })
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.calls.find(([sql]) => sql.includes('SELECT session."userId"'))?.[0]).toContain('session."controlGate" = \'open\'')
  })

  it("keeps in-flight lease cleanup on the open-session fence when the gate is paused", async () => {
    const fake = fakePool([row], "running", "user_1", "user_paused")
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    await expect(releaseTurnLease(fake.pool, current, "completed", now)).resolves.toBe(true)
    const sql = fake.calls.find(([text]) => text.includes('SET "status" = $5'))?.[0] ?? ""
    expect(sql).not.toContain('session."controlGate"')
    expect(fake.calls.some(([text]) => text.includes('session."status" NOT IN (\'aborted\', \'archived\')'))).toBe(true)
  })

  it("returns a typed recoverable error to a duplicate claimant", async () => {
    const fake = fakePool([])
    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toBeInstanceOf(TurnLeaseError)
    await expect(claimTurnLease(fake.pool, payload, now)).rejects.toMatchObject({ code: "lease_not_available", recoverable: true })
  })

  it("allows exactly one winner across 100 concurrent claim attempts", async () => {
    let claimed = false
    const clients = Array.from({ length: 100 }, () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE "agent_turns"')) {
          if (claimed) return { rows: [], rowCount: 0 }
          claimed = true
          return { rows: [row], rowCount: 1 }
        }
        if (sql.includes('SELECT session."userId"')) return { rows: [{ userId: "user_1", controlGate: "open" }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }))
    const fake = { connect: vi.fn(async () => clients.shift()!) } as unknown as LeasePool
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => claimTurnLease(
      fake,
      { ...payload, ownerId: `owner_${index}` },
      now,
    )))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof TurnLeaseError && result.reason.code === "lease_not_available")).toHaveLength(99)
  })

  it("fences heartbeat renewal by owner and lease version and caps the lease", async () => {
    const fake = fakePool([{ ...row, leaseExpiresAt: new Date(now.getTime() + 120_000) }])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    const result = await renewTurnLease(fake.pool, current, new Date(now.getTime() + 20_000))
    expect(result?.leaseVersion).toBe(row.leaseVersion)
    const sql = fake.calls.find(([text]) => text.includes('UPDATE "agent_turns"'))?.[0] ?? ""
    expect(sql).toContain('"leaseOwnerId" = $3')
    expect(sql).toContain("LEAST")
    expect(fake.calls.find(([text]) => text.includes('UPDATE "agent_turns"'))?.[1]).toContain(TURN_MAX_LEASE_MS)
  })

  it("does not release a lease after another owner fenced it", async () => {
    const fake = fakePool([])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    await expect(releaseTurnLease(fake.pool, current, "completed", now)).resolves.toBe(false)
    await expect(expireTurnLease(fake.pool, current, now)).resolves.toBe(false)
  })

  it("releases a matching persisted user wait with the same live fence", async () => {
    const fake = fakePool()
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    await expect(releaseTurnLease(fake.pool, current, "waiting_for_user", now)).resolves.toBe(true)
    const [sql, params] = fake.calls.find(([text]) => text.includes('SET "status" = $5')) ?? ["", []]
    expect(sql).toContain('"status" = \'in_progress\' OR ("status" = \'waiting_for_user\' AND $5 = \'waiting_for_user\')')
    expect(sql).toContain('"userId" = $7')
    expect(sql).toContain('"leaseExpiresAt" > $6')
    expect(params).toEqual([current.turnId, current.sessionId, current.ownerId, current.leaseVersion, "waiting_for_user", now, current.userId])
  })

  it("can fence an already-expired heartbeat before a scanner reclaims it", async () => {
    const fake = fakePool([row])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    await expect(interruptTurnLease(fake.pool, current, now)).resolves.toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes("leaseOwnerId\" IS NULL"))).toBe(true)
  })

  it.each(["renew", "expire", "release", "interrupt"] as const)("fails closed without a Turn write when the session is archived (%s)", async (operation) => {
    const fake = fakePool([row], "archived")
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }

    if (operation === "renew") await expect(renewTurnLease(fake.pool, current, now)).resolves.toBeNull()
    if (operation === "expire") await expect(expireTurnLease(fake.pool, current, now)).resolves.toBe(false)
    if (operation === "release") await expect(releaseTurnLease(fake.pool, current, "completed", now)).resolves.toBe(false)
    if (operation === "interrupt") await expect(interruptTurnLease(fake.pool, current, now)).resolves.toBe(false)
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
  })
})
