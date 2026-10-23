import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { appendScheduledGateChoiceWaitEvents } from "./turn-question-gate-choice-events.js"
import type { TurnQuestionQueryClient } from "./turn-question-store-guards.js"

const owner: TurnExecutionOwnerFence = { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-10-23T12:01:00.000Z") }

describe("scheduled Gate choice events", () => {
  it("writes root wait and question events with transactional outboxes", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    let sequence = 0
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes("ORDER BY \"sequence\" DESC")) return { rows: [{ id: "gate-result-event" }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = $2')) return { rows: [], rowCount: 0 }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: String(++sequence) }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_events"')) return { rows: [], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected_gate_choice_event_query:${sql}`)
    }) }

    await appendScheduledGateChoiceWaitEvents(client as unknown as TurnQuestionQueryClient, { owner, stepId: "root-step-4",
      itemId: "agent-wait:question:gate-wait", waitId: "gate-wait" })

    const events = calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))
    expect(events).toHaveLength(2)
    expect(events[0]?.values?.slice(0, 9)).toEqual([expect.stringMatching(/^agent-scheduled-gate-choice-step-/), "session-1", "turn-1", null, "root-1", "1", "step.completed", "root-step-4", "gate-result-event"])
    expect(JSON.parse(String(events[0]?.values?.[10]))).toEqual({ stepId: "root-step-4", status: "waiting_for_user", taskId: "root-1" })
    expect(events[1]?.values?.slice(0, 7)).toEqual([expect.stringMatching(/^agent-scheduled-gate-choice-item-/), "session-1", "turn-1", "agent-wait:question:gate-wait", "root-1", "2", "item.started"])
    expect(JSON.parse(String(events[1]?.values?.[10]))).toEqual({ itemId: "agent-wait:question:gate-wait", waitKind: "question", questionId: "gate-wait", toolCallId: null })
    expect(calls.filter(call => call.sql.includes('INSERT INTO "agent_outbox"'))).toHaveLength(2)
  })
})
