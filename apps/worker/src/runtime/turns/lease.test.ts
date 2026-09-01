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

function fakePool(rows: unknown[] = [row]) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => { calls.push([sql, params]); return { rows, rowCount: rows.length } }),
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
    expect(fake.calls[0][0]).toBe("BEGIN")
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

  it("can fence an already-expired heartbeat before a scanner reclaims it", async () => {
    const fake = fakePool([row])
    const current: TurnLease = { ...payload, userId: row.userId, leaseVersion: row.leaseVersion, leaseStartedAt: now, leaseExpiresAt: row.leaseExpiresAt }
    await expect(interruptTurnLease(fake.pool, current, now)).resolves.toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes("leaseOwnerId\" IS NULL"))).toBe(true)
  })
})
