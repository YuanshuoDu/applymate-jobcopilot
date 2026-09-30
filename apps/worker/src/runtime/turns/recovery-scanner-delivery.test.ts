import { describe, expect, it, vi } from "vitest"

import type { LeasePool } from "./lease.js"
import { dispatchPendingTurnOutbox } from "./recovery-scanner-delivery.js"
import { turnJobId } from "./recovery-scanner-common.js"

describe("recovery scanner queue delivery", () => {
  it("enqueues a validated row under its generation ID before marking it published", async () => {
    const calls: Array<[string, unknown[]?]> = []
    const payload = { turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1" }
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes('SELECT dispatch."id", dispatch."aggregateId"')) {
          return { rows: [{ id: "outbox-1", aggregateId: "session-1", payload, attemptCount: 2 }], rowCount: 1 }
        }
        if (sql.includes('SELECT session."id"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT dispatch."id" FROM "agent_outbox"')) return { rows: [{ id: "outbox-1" }], rowCount: 1 }
        if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool
    const queue = { add: vi.fn().mockResolvedValue(undefined) }

    await expect(dispatchPendingTurnOutbox(pool, queue)).resolves.toBe(1)

    expect(queue.add).toHaveBeenCalledWith("turn", payload, { jobId: turnJobId("turn-1", 2), attempts: 5 })
    const publishIndex = calls.findIndex(([sql]) => sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP'))
    const lineageIndex = calls.findIndex(([sql]) => sql.includes('FROM "agent_turns" AS turn'))
    expect(lineageIndex).toBeGreaterThanOrEqual(0)
    expect(publishIndex).toBeGreaterThan(lineageIndex)
    expect(client.release).toHaveBeenCalledTimes(2)
  })
})
