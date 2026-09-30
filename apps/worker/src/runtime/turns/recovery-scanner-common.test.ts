import { describe, expect, it, vi } from "vitest"

import { turnDispatchKey, turnJobId, withTransaction } from "./recovery-scanner-common.js"
import type { LeasePool } from "./lease.js"

describe("recovery scanner shared helpers", () => {
  it("creates stable dispatch keys and colon-free queue job IDs", () => {
    expect(turnDispatchKey("turn_1")).toBe("turn-dispatch:turn_1")
    expect(turnJobId("turn:one", 2)).toBe(`agent-turn-${Buffer.from("turn:one").toString("base64url")}-2`)
    expect(() => turnJobId("turn_1", -1)).toThrow(RangeError)
  })

  it("commits successful work and rolls back failures while releasing the client", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }), release: vi.fn() }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool
    await expect(withTransaction(pool, async () => "done")).resolves.toBe("done")
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"])
    expect(client.release).toHaveBeenCalledOnce()

    client.query.mockClear()
    client.query.mockImplementation(async (sql: string) => {
      if (sql === "COMMIT") throw new Error("commit failed")
      return { rows: [], rowCount: 1 }
    })
    await expect(withTransaction(pool, async () => "done")).rejects.toThrow("commit failed")
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT", "ROLLBACK"])
    expect(client.release).toHaveBeenCalledTimes(2)
  })
})
