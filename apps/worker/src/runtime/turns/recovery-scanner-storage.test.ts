import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import type { LeasePool, TurnJobPayload } from "./lease.js"
import { persistTurnDispatch, persistTurnDispatchInTransaction, reclaimExpiredTurns } from "./recovery-scanner-storage.js"

function fakePool(handler: (sql: string, params?: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      return { rows: [], rowCount: 1, ...handler(sql, params) }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool, calls, client }
}

const payload: TurnJobPayload = { turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1" }

describe("recovery scanner persistence helpers", () => {
  it("locks an open session and verifies Turn lineage before persisting a reset dispatch", async () => {
    const fake = fakePool(() => ({ rows: [{ id: "turn-1" }], rowCount: 1 }))
    await persistTurnDispatch(fake.pool, payload, true)

    const sql = fake.calls.map(([text]) => text)
    expect(sql[0]).toBe("BEGIN")
    expect(sql[1]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(sql[2]).toContain('session."userId" = turn."userId"')
    expect(sql[3]).toContain('WHERE "agent_outbox"."topic" = EXCLUDED."topic"')
    expect(fake.calls[3]?.[1]).toEqual(expect.arrayContaining(["session-1", "turn-dispatch:turn-1"]))
    expect(sql.at(-1)).toBe("COMMIT")
  })

  it("rejects mismatched lineage before writing a dispatch", async () => {
    const fake = fakePool(() => ({ rows: [], rowCount: 0 }))
    await expect(persistTurnDispatchInTransaction(fake.client as unknown as Pick<pg.PoolClient, "query">, payload)).rejects.toThrow("turn_dispatch_lineage_mismatch")
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("maps reclaimed leases to their prior fencing version", async () => {
    const fake = fakePool(sql => sql.includes("WITH stale")
      ? { rows: [{ id: "turn-1", sessionId: "session-1", leaseVersion: 8 }], rowCount: 1 }
      : {})
    await expect(reclaimExpiredTurns(fake.pool, new Date("2026-09-23T12:00:00Z"), 10)).resolves.toEqual([
      { turnId: "turn-1", sessionId: "session-1", previousLeaseVersion: 7 },
    ])
    expect(fake.calls.find(([sql]) => sql.includes("WITH stale"))?.[0]).toContain("SKIP LOCKED")
  })
})
