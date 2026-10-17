import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { appendTaskGraphReceipt, writeTaskLifecycleReceipt } from "./task-graph-pg-events.js"
import type { GraphScope } from "./task-graph-pg-state.js"
import type { TaskGraphEvent } from "../planning/task-graph.js"

describe("TaskGraph event persistence", () => {
  it("persists an itemless private receipt without writing an outbox record", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('RETURNING "eventSequence"')) return { rows: [{ eventSequence: "17" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }) } as unknown as Pick<pg.PoolClient, "query">
    const scope: GraphScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1 }
    await appendTaskGraphReceipt(client, { scope, itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation",
      idempotencyKey: "agent.plan.reconciliation:sha256:" + "a".repeat(64), actor: "orchestrator",
      causationId: "step-2", payload: { schemaVersion: "agent-harness.v2.plan-reconciliation.v1", steerInputIds: ["private-input"] }, outbox: false })

    const event = calls.find(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(event?.values?.[3]).toBeNull()
    expect(event?.values?.[4]).toBe(scope.rootTaskId)
    expect(event?.values?.[6]).toBe("agent.plan.reconciliation")
    expect(event?.values?.[7]).toBe("orchestrator")
    expect(calls.some(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("redacts and bounds worker failure text before writing the event and stream outbox", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        if (sql.includes('RETURNING "eventSequence"')) return { rows: [{ eventSequence: "4" }], rowCount: 1 }
        if (sql.startsWith('UPDATE "agent_items"')) return { rows: [{
          stepId: "step-1", status: "streaming", phase: null,
          startedAt: new Date("2026-09-01T00:00:00.000Z"), completedAt: null, createdAt: new Date("2026-09-01T00:00:00.000Z"),
        }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }),
    } as unknown as Pick<pg.PoolClient, "query">
    const scope: GraphScope = {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
    }
    const rawFailure = "authorization: Bearer abcdefghijklmnop user@example.com\n" + "detail ".repeat(100)
    const event: TaskGraphEvent = {
      type: "task.failed", idempotencyKey: "event-key", expectedRevision: 2, nodeKey: "child", failureReason: rawFailure,
    }

    await writeTaskLifecycleReceipt(client, scope, "graph-item", "child-task", event, 2, { schemaVersion: "agent-harness.v2.task-graph", nodes: [] })

    const eventWrite = calls.find(call => call.sql.includes('INSERT INTO "agent_events"'))
    const persisted = JSON.parse(String(eventWrite?.values?.[10])) as { event: TaskGraphEvent }
    expect(eventWrite?.values?.[4]).toBe("child-task")
    expect(eventWrite?.values?.[4]).toBe("child-task")
    expect(persisted.event.type).toBe("task.failed")
    if (persisted.event.type !== "task.failed") throw new Error("expected task.failed event")
    expect(persisted.event.failureReason).not.toContain("abcdefghijklmnop")
    expect(persisted.event.failureReason).not.toContain("user@example.com")
    expect(persisted.event.failureReason).not.toContain("\n")
    expect(Buffer.byteLength(persisted.event.failureReason, "utf8")).toBeLessThanOrEqual(500)
    const outboxWrite = calls.find(call => call.sql.includes('INSERT INTO "agent_outbox"'))
    expect(outboxWrite).toBeDefined()
    expect(String(outboxWrite?.values?.[3])).not.toContain("abcdefghijklmnop")
  })
})
