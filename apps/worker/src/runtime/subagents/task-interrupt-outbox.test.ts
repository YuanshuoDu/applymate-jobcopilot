import { describe, expect, it, vi } from "vitest"

import { drainTaskInterruptOutbox, parseTaskInterruptIntent, TASK_INTERRUPT_OUTBOX_TOPIC } from "./task-interrupt-outbox.js"
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
})
