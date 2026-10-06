import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { appendQuestionStartedEvents } from "./turn-question-store-events.js"
import type { TurnQuestionQueryClient } from "./turn-question-store-guards.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-01T00:01:00Z"),
}
const input = { owner, stepId: "step-1", itemId: "agent-wait:question:q1", questionId: "q1", toolCallId: "call-1", toolCallCount: 2 }

describe("native question events", () => {
  it("writes step close and canonical question start with matching transactional outboxes", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    let sequence = 0
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('ORDER BY "sequence" DESC')) return { rows: [{ id: "tool-result-event" }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = $2')) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: String(++sequence) }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }) }

    await appendQuestionStartedEvents(client as unknown as TurnQuestionQueryClient, input)

    const events = calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(events).toHaveLength(2)
    expect(events[0]?.values).toEqual([
      "agent-question-step-event-step-1", "session-1", "turn-1", null, "root-1", "1", "step.completed", "step-1", "tool-result-event",
      "turn:turn-1:event:step-completed:step-1", JSON.stringify({ stepId: "step-1", status: "waiting_for_user", toolCallCount: 2, taskId: "root-1" }),
    ])
    expect(events[1]?.values).toEqual([
      "agent-question-item-event-q1", "session-1", "turn-1", input.itemId, "root-1", "2", "item.started", input.itemId, "q1",
      `agent-wait:${input.itemId}:started`, JSON.stringify({ itemId: input.itemId, waitKind: "question", questionId: "q1", toolCallId: "call-1" }),
    ])
    expect(calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toHaveLength(2)
  })

  it("fails closed on an idempotency collision with a different event identity", async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('ORDER BY "sequence" DESC')) return { rows: [{ id: "event-prev" }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = $2')) return { rows: [{ id: "foreign", turnId: owner.turnId, itemId: null, taskId: owner.taskId, sequence: "3", type: "step.completed", actor: "orchestrator", correlationId: input.stepId, causationId: "event-prev", idempotencyKey: `turn:${owner.turnId}:event:step-completed:${input.stepId}`, payload: { unrelated: true } }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }) }
    await expect(appendQuestionStartedEvents(client as unknown as TurnQuestionQueryClient, input)).rejects.toThrow(/event turn:/)
  })
})
