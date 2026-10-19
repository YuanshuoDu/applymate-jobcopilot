import { describe, expect, it, vi } from "vitest"

import type { LeasePool } from "./lease.js"
import { dispatchPendingTurnOutbox } from "./recovery-scanner-delivery.js"
import { TURN_DISPATCH_LINEAGE_ERROR, turnJobId } from "./recovery-scanner-common.js"

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
        if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: "turn-1", source: "user", executionMode: null }], rowCount: 1 }
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
    expect(calls[lineageIndex]?.[0]).toContain('turn."executionMode"')
    expect(lineageIndex).toBeGreaterThanOrEqual(0)
    expect(publishIndex).toBeGreaterThan(lineageIndex)
    expect(client.release).toHaveBeenCalledTimes(2)
  })

  it("does not let older safely held automation rows starve a later canonical dispatch", async () => {
    const heldRows = [
      { id: "unresolved-dispatch", aggregateId: "session-1", payload: { turnId: "turn-unresolved", sessionId: "session-1", ownerId: "agent-run:turn-unresolved" }, attemptCount: 0, publishedAt: null as Date | null },
      { id: "legacy-dispatch", aggregateId: "session-1", payload: { turnId: "turn-legacy", sessionId: "session-1", ownerId: "agent-run:turn-legacy" }, attemptCount: 0, publishedAt: null as Date | null },
    ]
    const canonical = { id: "canonical-dispatch", aggregateId: "session-1", payload: { turnId: "turn-canonical", sessionId: "session-1", ownerId: "agent-run:turn-canonical" }, attemptCount: 0, publishedAt: null as Date | null }
    const rows = [...heldRows, canonical]
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes('SELECT dispatch."id", dispatch."aggregateId"')) {
          // The SQL predicate removes only exact automation lineage pinned null/legacy.
          return { rows: [canonical], rowCount: 1 }
        }
        if (sql.includes('SELECT session."id"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT dispatch."id" FROM "agent_outbox"')) {
          return params?.[0] === canonical.id ? { rows: [{ id: canonical.id }], rowCount: 1 } : { rows: [], rowCount: 0 }
        }
        if (sql.includes('FROM "agent_turns" AS turn')) {
          return { rows: [{ id: "turn-canonical", source: "automation", executionMode: "canonical_task_graph" }], rowCount: 1 }
        }
        if (sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) {
          const row = rows.find(candidate => candidate.id === params?.[0])
          if (row) row.publishedAt = new Date("2026-10-19T09:00:00Z")
          return { rows: [], rowCount: row ? 1 : 0 }
        }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool
    const queue = { add: vi.fn().mockResolvedValue(undefined) }

    await expect(dispatchPendingTurnOutbox(pool, queue, 1)).resolves.toBe(1)

    const select = calls.find(([sql]) => sql.includes('SELECT dispatch."id", dispatch."aggregateId"'))?.[0] ?? ""
    expect(select).toContain('heldTurn."id" = dispatch."payload"->>\'turnId\'')
    expect(select).toContain('heldTurn."sessionId" = dispatch."payload"->>\'sessionId\'')
    expect(select).toContain('heldSession."id" = dispatch."aggregateId"')
    expect(select).toContain('heldSession."userId" = heldTurn."userId"')
    expect(select).toContain('heldTurn."source" = \'automation\'')
    expect(select).toContain('heldTurn."executionMode" IS NULL')
    expect(select).toContain('heldTurn."executionMode" = \'legacy_pipeline_adapter\'')
    expect(queue.add).toHaveBeenCalledWith("turn", canonical.payload, { jobId: turnJobId("turn-canonical", 0), attempts: 5 })
    expect(heldRows.map(row => row.publishedAt)).toEqual([null, null])
    expect(canonical.publishedAt).toEqual(new Date("2026-10-19T09:00:00Z"))
  })

  it("keeps malformed lineage eligible for quarantine instead of treating it as safely held", async () => {
    const malformed = { id: "mismatched-dispatch", aggregateId: "session-1", payload: { turnId: "turn-1", sessionId: "other-session", ownerId: "agent-run:turn-1" }, attemptCount: 0 }
    const calls: Array<[string, unknown[]?]> = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params])
        if (sql.includes('SELECT dispatch."id", dispatch."aggregateId"')) return { rows: [malformed], rowCount: 1 }
        if (sql.includes('SELECT session."id"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT dispatch."id" FROM "agent_outbox"')) return { rows: [{ id: malformed.id }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool
    const queue = { add: vi.fn().mockResolvedValue(undefined) }

    await expect(dispatchPendingTurnOutbox(pool, queue, 1)).resolves.toBe(0)

    const select = calls.find(([sql]) => sql.includes('SELECT dispatch."id", dispatch."aggregateId"'))?.[0] ?? ""
    expect(select).toContain('heldTurn."sessionId" = dispatch."payload"->>\'sessionId\'')
    expect(calls).toContainEqual([
      expect.stringContaining('SET "attemptCount" = "attemptCount" + 1, "lastError" = $2'),
      [malformed.id, TURN_DISPATCH_LINEAGE_ERROR],
    ])
    expect(queue.add).not.toHaveBeenCalled()
  })

  it.each([null, "legacy_pipeline_adapter", "malformed"] as const)(
    "keeps an automation Turn with mode %s out of the canonical queue",
    async executionMode => {
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT dispatch."id", dispatch."aggregateId"')) {
            return { rows: [{ id: "outbox-1", aggregateId: "session-1", payload: { turnId: "turn-1", sessionId: "session-1", ownerId: "agent-run:turn-1" }, attemptCount: 0 }], rowCount: 1 }
          }
          if (sql.includes('SELECT session."id"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
          if (sql.includes('SELECT dispatch."id" FROM "agent_outbox"')) return { rows: [{ id: "outbox-1" }], rowCount: 1 }
          if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: "turn-1", source: "automation", executionMode }], rowCount: 1 }
          return { rows: [], rowCount: 1 }
        }),
        release: vi.fn(),
      }
      const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool
      const queue = { add: vi.fn().mockResolvedValue(undefined) }

      await expect(dispatchPendingTurnOutbox(pool, queue)).resolves.toBe(0)

      expect(queue.add).not.toHaveBeenCalled()
      expect(client.query.mock.calls.some(([sql]) => String(sql).includes('SET "publishedAt" = CURRENT_TIMESTAMP'))).toBe(false)
    },
  )

  it("delivers a canonical-pinned automation Turn", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT dispatch."id", dispatch."aggregateId"')) {
          return { rows: [{ id: "outbox-1", aggregateId: "session-1", payload: { turnId: "turn-1", sessionId: "session-1", ownerId: "agent-run:turn-1" }, attemptCount: 0 }], rowCount: 1 }
        }
        if (sql.includes('SELECT session."id"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT dispatch."id" FROM "agent_outbox"')) return { rows: [{ id: "outbox-1" }], rowCount: 1 }
        if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: "turn-1", source: "automation", executionMode: "canonical_task_graph" }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool
    const queue = { add: vi.fn().mockResolvedValue(undefined) }

    await expect(dispatchPendingTurnOutbox(pool, queue)).resolves.toBe(1)

    expect(queue.add).toHaveBeenCalledOnce()
  })
})
