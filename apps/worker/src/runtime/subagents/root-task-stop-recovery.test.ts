import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { recoverExpiredStoppedRoots } from "./root-task-stop-recovery.js"
import type { PgSubagentPool } from "./types.js"

const candidate = { id: "root-turn-1", sessionId: "session-1", turnId: "turn-1", userId: "user-1", attemptCount: 1 }

function fixture(options: { candidates?: readonly typeof candidate[]; sessionUserId?: string; updateCount?: number; eventSequence?: string; outboxCount?: number } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "sub_agent_tasks" AS root') && sql.startsWith("SELECT")) {
        return { rows: [...(options.candidates ?? [candidate])], rowCount: options.candidates?.length ?? 1 }
      }
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
        return { rows: [{ userId: options.sessionUserId ?? "user-1" }], rowCount: 1 }
      }
      if (sql.startsWith('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: options.eventSequence ?? "8" }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks" AS root')) return { rows: [], rowCount: options.updateCount ?? 1 }
      if (sql.startsWith('INSERT INTO "agent_events"')) return { rows: [], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: options.outboxCount ?? 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool, calls }
}

describe("expired stopped root recovery", () => {
  it("settles only an expired, Stop-marked root under its exact session, turn, and owner", async () => {
    const fake = fixture()

    await expect(recoverExpiredStoppedRoots(fake.pool)).resolves.toBe(1)

    const scan = fake.calls.find(call => call.sql.includes('FROM "sub_agent_tasks" AS root') && call.sql.startsWith("SELECT"))
    expect(scan?.sql).toContain('root."id" = root."rootTaskId"')
    expect(scan?.sql).toContain('root."parentTaskId" IS NULL')
    expect(scan?.sql).toContain('turn."status" = \'interrupted\'')
    expect(scan?.sql).toContain('root."interruptRequestedAt" IS NOT NULL')
    expect(scan?.sql).toContain('root."leaseExpiresAt" <= clock_timestamp()')
    const update = fake.calls.find(call => call.sql.startsWith('UPDATE "sub_agent_tasks" AS root'))
    expect(update?.sql).toContain('root."sessionId" = $2 AND root."turnId" = $3')
    expect(update?.sql).toContain('root."attemptCount" = $4')
    expect(update?.sql).toContain('session."userId" = $7')
    expect(update?.sql).toContain('turn."status" = \'interrupted\'')
    expect(update?.values.slice(0, 4)).toEqual([candidate.id, candidate.sessionId, candidate.turnId, candidate.attemptCount])
    expect(fake.calls.some(call => call.sql.includes("set_config") && call.values[1] === "user-1")).toBe(true)

    const notification = fake.calls.find(call => call.sql.startsWith('INSERT INTO "agent_events"'))
    expect(notification?.sql).toContain("'task.interrupted'")
    expect(notification?.values?.slice(1, 6)).toEqual([
      candidate.sessionId, candidate.turnId, candidate.id, "8", "agent-root-stop:root-turn-1:attempt:1:task.interrupted",
    ])
    expect(JSON.parse(String(notification?.values?.[6]))).toEqual({
      taskId: candidate.id, status: "interrupted", attemptCount: 1,
      failureReason: "Persisted Stop outlived the Worker lease before a terminal receipt was recorded.",
    })
    const notificationOutbox = fake.calls.find(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))
    expect(notificationOutbox?.sql).toContain("'agent.session.event'")
    expect(JSON.parse(String(notificationOutbox?.values?.[3]))).toMatchObject({
      eventId: "agent-root-stop-root-turn-1-attempt-1", sessionId: candidate.sessionId,
      turnId: candidate.turnId, itemId: null, taskId: candidate.id, sequence: "8",
      type: "task.interrupted", actor: "system", correlationId: candidate.turnId,
      idempotencyKey: "agent-root-stop:root-turn-1:attempt:1:task.interrupted",
    })
    expect(JSON.parse(String(notificationOutbox?.values?.[3]))).not.toHaveProperty("payload.kind")
    expect(fake.calls.findIndex(call => call.sql.startsWith('UPDATE "sub_agent_tasks" AS root')))
      .toBeLessThan(fake.calls.findIndex(call => call.sql.startsWith('INSERT INTO "agent_events"')))
    expect(fake.calls.findIndex(call => call.sql.startsWith('INSERT INTO "agent_events"')))
      .toBeLessThan(fake.calls.findIndex(call => call.sql.startsWith('INSERT INTO "agent_outbox"')))
  })

  it("does not mutate a root if the locked session no longer matches its candidate owner", async () => {
    const fake = fixture({ sessionUserId: "different-user" })

    await expect(recoverExpiredStoppedRoots(fake.pool)).resolves.toBe(0)

    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "sub_agent_tasks" AS root'))).toBe(false)
    expect(fake.calls.some(call => call.sql.includes("set_config"))).toBe(false)
  })

  it("rejects an invalid recovery limit before acquiring a connection", async () => {
    const fake = fixture()

    await expect(recoverExpiredStoppedRoots(fake.pool, 0)).rejects.toThrow("Stopped root recovery limit must be positive")
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })

  it("rolls back the root terminal state if its lifecycle notification cannot be queued", async () => {
    const fake = fixture({ outboxCount: 0 })

    await expect(recoverExpiredStoppedRoots(fake.pool)).rejects.toThrow("stopped_root_event_outbox_conflict")

    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "sub_agent_tasks" AS root'))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_events"'))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith("ROLLBACK"))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith("COMMIT"))).toBe(false)
  })
})
