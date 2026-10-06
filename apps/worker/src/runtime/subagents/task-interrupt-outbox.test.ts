import { describe, expect, it, vi } from "vitest"

import { drainTaskInterruptOutbox, parseTaskInterruptIntent, TASK_INTERRUPT_OUTBOX_MAX_PROCESSING_ATTEMPTS, TASK_INTERRUPT_OUTBOX_TOPIC } from "./task-interrupt-outbox.js"
import type { PgSubagentPool } from "./types.js"

describe("task interrupt outbox", () => {
  it("parses only the exact authoritative intent shape", () => {
    const intent = { sessionId: "session-1", turnId: "turn-1", taskId: "task-1", intentId: "intent-1" }
    expect(parseTaskInterruptIntent(intent)).toEqual(intent)
    expect(parseTaskInterruptIntent({ ...intent, rootTaskId: "client-root" })).toBeNull()
    expect(parseTaskInterruptIntent({ ...intent, taskId: " " })).toBeNull()
  })

  it("polls only the topic-specific outbox and reconciles durable completion events", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values })
        if (sql.includes('SELECT "id" FROM "agent_outbox"')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT command."payload"')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool
    const manager = { signalTaskSubtree: vi.fn() }

    await expect(drainTaskInterruptOutbox(pool, manager as never)).resolves.toBe(0)
    const topicQueries = statements.filter(entry => entry.sql.includes('FROM "agent_outbox"') && entry.sql.includes('"topic"'))
    expect(topicQueries[0]?.values?.[0]).toBe(TASK_INTERRUPT_OUTBOX_TOPIC)
    expect(topicQueries[0]?.sql).toContain('"publishedAt" IS NULL')
    expect(topicQueries.some(entry => entry.sql.includes("agent.task-graph.stop"))).toBe(false)
    const reconcile = statements.find(entry => entry.sql.includes('SELECT command."payload"'))
    expect(reconcile?.sql).toContain('"idempotencyKey" = \'agent-task-interrupt:\'')
    expect(reconcile?.sql).toContain('ORDER BY command."createdAt", command."id" LIMIT $2')
    expect(reconcile?.sql).not.toContain('command."createdAt" DESC')
  })

  it.each(["aborted", "archived"])("terminalizes an accepted intent for a %s session without touching tasks", async status => {
    const intent = { sessionId: "session-1", turnId: "turn-1", taskId: "task-1", intentId: "intent-1" }
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        if (sql.includes('SELECT "id" FROM "agent_outbox"') && sql.includes("SKIP LOCKED")) {
          return { rows: [{ id: "intent-row" }], rowCount: 1 }
        }
        if (sql.includes('SELECT "id", "aggregateId", "payload", "publishedAt"')) {
          return { rows: [{ id: "intent-row", aggregateId: intent.sessionId, payload: intent, publishedAt: null }], rowCount: 1 }
        }
        if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: intent.sessionId, userId: "user-1", status }], rowCount: 1 }
        }
        if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: intent.turnId }], rowCount: 1 }
        if (sql.includes('FROM "agent_events"')) return { rows: [], rowCount: 0 }
        if (sql.includes('UPDATE "agent_sessions"') && sql.includes('"eventSequence"')) {
          return { rows: [{ eventSequence: "2" }], rowCount: 1 }
        }
        if (sql.includes('SELECT command."payload"')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool
    const manager = { signalTaskSubtree: vi.fn() }

    await expect(drainTaskInterruptOutbox(pool, manager as never)).resolves.toBe(1)

    const reconcileIndex = calls.findIndex(call => call.sql.includes('SELECT command."payload"'))
    expect(calls.slice(0, reconcileIndex).some(call => call.sql.includes('"sub_agent_tasks"'))).toBe(false)
    const eventInsert = calls.find(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(eventInsert?.values?.[5]).toBe("task.interrupt.failed")
    expect(String(eventInsert?.values?.[8])).toContain('"status":"failed"')
    const publishIndex = calls.findIndex(call => call.sql.includes('UPDATE "agent_outbox"') && call.sql.includes('"publishedAt" = CURRENT_TIMESTAMP'))
    expect(publishIndex).toBeGreaterThan(calls.indexOf(eventInsert!))
    expect(manager.signalTaskSubtree).not.toHaveBeenCalled()
  })

  it("bounds poison retries so later intents progress after durable failure", async () => {
    type StoredIntent = { id: string; aggregateId: string; payload: unknown; publishedAt: Date | null; attemptCount: number; lastError: string | null }
    const poison = Array.from({ length: 20 }, (_, index) => ({
      id: `poison-${index}`, aggregateId: `session-${index}`,
      payload: { sessionId: `session-${index}`, turnId: `turn-${index}`, taskId: `task-${index}`, intentId: `intent-${index}` },
      publishedAt: null, attemptCount: TASK_INTERRUPT_OUTBOX_MAX_PROCESSING_ATTEMPTS - 2, lastError: null,
    }))
    const fresh: StoredIntent = { id: "fresh-row", aggregateId: "fresh-session", payload: { sessionId: "fresh-session", turnId: "fresh-turn", taskId: "fresh-task", intentId: "fresh-intent" }, publishedAt: null, attemptCount: 0, lastError: null }
    const rows = [...poison, fresh]
    const sessions = new Map<string, { id: string; userId: string; status: string }>([...poison.map(row => [row.aggregateId, { id: row.aggregateId, userId: "user-1", status: "active" }] as const), [fresh.aggregateId, { id: fresh.aggregateId, userId: "user-1", status: "archived" }]])
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    let eventSequence = 0
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        const args = values ?? []
        if (sql.includes('SELECT "id" FROM "agent_outbox"') && sql.includes("SKIP LOCKED")) {
          return { rows: rows.filter(row => row.publishedAt === null).slice(0, 20).map(({ id }) => ({ id })), rowCount: 0 }
        }
        if (sql.includes('SELECT "id", "aggregateId", "payload", "publishedAt", "attemptCount"')) {
          return { rows: rows.filter(row => row.id === args[0]).map(row => ({ ...row })), rowCount: 1 }
        }
        if (sql.includes('SELECT "id", "aggregateId", "payload", "publishedAt"')) {
          return { rows: rows.filter(row => row.id === args[0]).map(row => ({ ...row })), rowCount: 1 }
        }
        if (sql.includes('FROM "agent_sessions"')) return { rows: [sessions.get(String(args[0]))].filter(Boolean), rowCount: 1 }
        if (sql.includes("type" ) && sql.includes("task.interrupt.accepted")) return { rows: [{ id: "accepted-event" }], rowCount: 1 }
        if (sql.includes('FROM "agent_events"')) return { rows: [], rowCount: 0 }
        if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: String(args[0]) }], rowCount: 1 }
        if (sql.includes('UPDATE "agent_sessions"') && sql.includes('"eventSequence"')) return { rows: [{ eventSequence: String(++eventSequence) }], rowCount: 1 }
        if (sql.includes('INSERT INTO "agent_events"') || sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
        if (sql.includes('FROM "sub_agent_tasks" task JOIN "agent_turns"')) throw new Error("deterministic poisoned lineage read")
        if (sql.includes('UPDATE "agent_outbox"')) {
          const row = rows.find(item => item.id === args[0])
          if (!row) return { rows: [], rowCount: 0 }
          row.attemptCount++
          if (sql.includes('"publishedAt" = CURRENT_TIMESTAMP')) {
            row.publishedAt = new Date()
            row.lastError = args[1] === null || args[1] === undefined ? null : String(args[1])
          } else row.lastError = "processing_error"
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT command."payload"')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool
    const manager = { signalTaskSubtree: vi.fn() }

    await expect(drainTaskInterruptOutbox(pool, manager as never)).resolves.toBe(0)
    expect(poison.every(row => row.publishedAt === null && row.attemptCount === TASK_INTERRUPT_OUTBOX_MAX_PROCESSING_ATTEMPTS - 1 && row.lastError === "processing_error")).toBe(true)
    await expect(drainTaskInterruptOutbox(pool, manager as never)).resolves.toBe(20)
    expect(poison.every(row => row.publishedAt !== null && row.attemptCount === TASK_INTERRUPT_OUTBOX_MAX_PROCESSING_ATTEMPTS && row.lastError === "processing_error_max_attempts")).toBe(true)
    expect(fresh.publishedAt).toBeNull()

    const eventIndex = calls.findIndex(call => call.sql.includes('INSERT INTO "agent_events"') && call.values?.[1] === poison[0]?.aggregateId)
    const eventOutboxIndex = calls.findIndex(call => call.sql.includes('INSERT INTO "agent_outbox"') && call.values?.[1] === poison[0]?.aggregateId)
    const terminalIndex = calls.findIndex(call => call.sql.includes('UPDATE "agent_outbox"') && call.sql.includes('"publishedAt" = CURRENT_TIMESTAMP') && call.values?.[0] === poison[0]?.id)
    expect(eventIndex).toBeGreaterThanOrEqual(0)
    expect(eventOutboxIndex).toBeGreaterThan(eventIndex)
    expect(terminalIndex).toBeGreaterThan(eventOutboxIndex)
    const failureEvent = JSON.parse(String(calls[eventIndex]?.values?.[8])) as { code?: string; status?: string }
    expect(failureEvent).toMatchObject({ code: "processing_error_max_attempts", status: "failed" })

    await expect(drainTaskInterruptOutbox(pool, manager as never)).resolves.toBe(1)
    expect(fresh.publishedAt).not.toBeNull()
    expect(fresh.lastError).toBeNull()
  })

  it("terminalizes malformed pending rows with an explicit corruption error and no task event", async () => {
    const row = { id: "malformed-row", aggregateId: "unknown", payload: { taskId: "missing-authoritative-scope" }, publishedAt: null as Date | null, attemptCount: 0, lastError: null as string | null }
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        if (sql.includes('SELECT "id" FROM "agent_outbox"') && sql.includes("SKIP LOCKED")) return { rows: [{ id: row.id }], rowCount: 1 }
        if (sql.includes('SELECT "id", "aggregateId", "payload", "publishedAt", "attemptCount"')) return { rows: [{ ...row }], rowCount: 1 }
        if (sql.includes('SELECT "id", "aggregateId", "payload", "publishedAt"')) return { rows: [{ ...row }], rowCount: 1 }
        if (sql.includes('UPDATE "agent_outbox"')) { row.publishedAt = new Date(); row.attemptCount++; row.lastError = String(values?.[1]); return { rows: [], rowCount: 1 } }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as PgSubagentPool

    await expect(drainTaskInterruptOutbox(pool, { signalTaskSubtree: vi.fn() } as never)).resolves.toBe(1)
    expect(row).toMatchObject({ publishedAt: expect.any(Date), attemptCount: 1, lastError: "invalid_intent_payload" })
    expect(calls.some(call => call.sql.includes('INSERT INTO "agent_events"'))).toBe(false)
  })
})
