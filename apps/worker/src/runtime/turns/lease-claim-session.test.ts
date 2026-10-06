import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { ClaimSessionUnavailable, lockClaimSession } from "./lease-claim-session.js"

describe("Turn lease claim session lock", () => {
  it("locks an open session bound to the requested Turn and returns its owner", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ userId: "user-1" }], rowCount: 1 }))
    await expect(lockClaimSession({ query } as unknown as Pick<pg.PoolClient, "query">, { sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1" }))
      .resolves.toBe("user-1")
    expect(query.mock.calls[0]?.[0]).toContain('turn."id" = $2 AND turn."sessionId" = session."id" AND turn."userId" = session."userId"')
    expect(query.mock.calls[0]?.[1]).toEqual(["session-1", "turn-1"])
  })

  it("fails closed when the session and Turn binding is unavailable", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }))
    await expect(lockClaimSession({ query } as unknown as Pick<pg.PoolClient, "query">, { sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1" }))
      .rejects.toBeInstanceOf(ClaimSessionUnavailable)
  })
})
