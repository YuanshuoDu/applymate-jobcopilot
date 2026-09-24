import { describe, expect, it, vi } from "vitest"

import type { LeasePool } from "./lease.js"
import { ensureQueuedTurnDispatches } from "./recovery-scanner-queue-repair.js"
import { turnJobId, type TurnDispatchQueue } from "./recovery-scanner-common.js"

type DispatchState = { id: string; attemptCount: number; publishedAt: string | null; payload: unknown }

function fixture(initial: DispatchState | null = {
  id: "dispatch_1", attemptCount: 3, publishedAt: "2026-09-24 01:00:00.123456+00", payload: {},
}) {
  const state: { dispatch: DispatchState | null } = { dispatch: initial }
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('LEFT JOIN "agent_outbox" AS dispatch')) {
        const dispatch = state.dispatch
        return {
          rows: [{
            id: "turn_1", sessionId: "session_1", dispatchId: dispatch?.id ?? null,
            dispatchAttemptCount: dispatch?.attemptCount ?? null,
            dispatchPublishedAt: dispatch?.publishedAt ?? null,
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('SELECT turn."id" FROM "agent_turns" AS turn') && sql.includes("FOR UPDATE OF turn, session")) {
        return { rows: [{ id: "turn_1" }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        if (!state.dispatch) {
          state.dispatch = { id: String(params?.[0]), attemptCount: 0, publishedAt: null, payload: params?.[4] }
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('UPDATE "agent_outbox" AS dispatch')) {
        const dispatch = state.dispatch
        const matchesSnapshot = dispatch !== null && dispatch.id === params?.[1]
          && dispatch.attemptCount === params?.[5]
          && dispatch.publishedAt === params?.[6]
        if (dispatch && matchesSnapshot) {
          state.dispatch = { ...dispatch, attemptCount: dispatch.attemptCount + 1, publishedAt: null, payload: params?.[0] }
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool
  return { pool, state, client }
}

const turnKey = (turnId: string, generation?: number) => turnJobId(turnId, generation)

describe("queued Turn dispatch repair", () => {
  // BullMQ's getStateV2 maps both the normal wait and global paused Redis lists to "waiting".
  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children"] as const)(
    "preserves the published generation while BullMQ reports %s",
    async state => {
      const fake = fixture()
      const queue: TurnDispatchQueue = { add: vi.fn(), getJobState: vi.fn().mockResolvedValue(state) }

      await expect(ensureQueuedTurnDispatches(fake.pool, queue, "recovery_1", 50)).resolves.toBe(0)
      await expect(ensureQueuedTurnDispatches(fake.pool, queue, "recovery_1", 50)).resolves.toBe(0)

      expect(queue.getJobState).toHaveBeenCalledWith(turnKey("turn_1", 2))
      expect(fake.state.dispatch).toMatchObject({ attemptCount: 3, publishedAt: "2026-09-24 01:00:00.123456+00" })
      expect(fake.client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "agent_outbox" AS dispatch'))).toBe(false)
    },
  )

  it.each(["unknown", "completed", "failed"] as const)(
    "re-arms a published generation when BullMQ reports %s and the queued Turn remains eligible",
    async state => {
      const fake = fixture()
      const queue: TurnDispatchQueue = { add: vi.fn(), getJobState: vi.fn().mockResolvedValue(state) }

      await expect(ensureQueuedTurnDispatches(fake.pool, queue, "recovery_2", 50)).resolves.toBe(1)

      expect(queue.getJobState).toHaveBeenCalledWith(turnKey("turn_1", 2))
      expect(fake.state.dispatch).toMatchObject({ attemptCount: 4, publishedAt: null })
      const update = fake.client.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE "agent_outbox" AS dispatch'))
      expect(update?.[0]).toContain('dispatch."attemptCount" = $6 AND dispatch."publishedAt" = $7::timestamptz')
      expect(update?.[0]).toContain('turn."status" = \'queued\' AND turn."leaseOwnerId" IS NULL')
      expect(update?.[1]).toEqual(expect.arrayContaining(["dispatch_1", 3, "2026-09-24 01:00:00.123456+00"]))
      const turnLock = fake.client.query.mock.calls.find(([sql]) => String(sql).includes("FOR UPDATE OF turn, session"))
      expect(turnLock?.[0]).toContain('turn."status" = \'queued\' AND turn."leaseOwnerId" IS NULL')
      expect(turnLock?.[0]).toContain('session."controlGate" = \'open\'')
    },
  )

  it("uses the dispatch snapshot CAS so concurrent missing-job scans re-arm only once", async () => {
    const fake = fixture()
    let releaseProbes!: () => void
    const bothProbed = new Promise<void>(resolve => { releaseProbes = resolve })
    let probes = 0
    const queue: TurnDispatchQueue = {
      add: vi.fn(),
      getJobState: vi.fn(async () => {
        probes += 1
        if (probes === 2) releaseProbes()
        await bothProbed
        return "unknown" as const
      }),
    }

    const outcomes = await Promise.all([
      ensureQueuedTurnDispatches(fake.pool, queue, "recovery_a", 50),
      ensureQueuedTurnDispatches(fake.pool, queue, "recovery_b", 50),
    ])

    expect(outcomes.sort()).toEqual([0, 1])
    expect(fake.state.dispatch).toMatchObject({ attemptCount: 4, publishedAt: null })
    expect(fake.client.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE "agent_outbox" AS dispatch'))).toHaveLength(2)
  })

  it("does not re-arm if the Turn becomes claimed before the CAS transaction", async () => {
    const fake = fixture()
    fake.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('LEFT JOIN "agent_outbox" AS dispatch')) {
        return { rows: [{ id: "turn_1", sessionId: "session_1", dispatchId: "dispatch_1", dispatchAttemptCount: 3, dispatchPublishedAt: "2026-09-24 01:00:00.123456+00" }], rowCount: 1 }
      }
      if (sql.includes("FOR UPDATE OF turn, session")) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE "agent_outbox" AS dispatch')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const queue: TurnDispatchQueue = { add: vi.fn(), getJobState: vi.fn().mockResolvedValue("unknown") }

    await expect(ensureQueuedTurnDispatches(fake.pool, queue, "recovery_1", 50)).resolves.toBe(0)

    expect(fake.client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "agent_outbox" AS dispatch'))).toBe(false)
    expect(fake.state.dispatch).toMatchObject({ attemptCount: 3, publishedAt: "2026-09-24 01:00:00.123456+00" })
  })

  it("does not re-arm a published row when queue state cannot be inspected", async () => {
    const fake = fixture()
    const queue: TurnDispatchQueue = { add: vi.fn() }

    await expect(ensureQueuedTurnDispatches(fake.pool, queue, "recovery_3", 50)).resolves.toBe(0)

    expect(fake.state.dispatch).toMatchObject({ attemptCount: 3, publishedAt: "2026-09-24 01:00:00.123456+00" })
  })
})
