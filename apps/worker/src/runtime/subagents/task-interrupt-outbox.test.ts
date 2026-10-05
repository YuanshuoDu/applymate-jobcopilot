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
})
