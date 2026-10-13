import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { appendQuestionStartedEvents, recoverPausedOrphanUsage } from "./turn-question-store-events.js"
import type { TurnQuestionQueryClient } from "./turn-question-store-guards.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-01T00:01:00Z"),
}
const input = { owner, stepId: "step-1", itemId: "agent-wait:question:q1", questionId: "q1", toolCallId: "call-1", toolCallCount: 2 }

function pausedUsageFixture(completionPayload: unknown) {
  const stepId = "step-usage"
  const events = [
    { id: "model-start", sequence: "1", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: null,
      type: "model.started", actor: "orchestrator", correlationId: stepId, causationId: null,
      idempotencyKey: `turn:${owner.turnId}:event:model-started:${stepId}`, payload: { taskId: owner.taskId, provider: "fixture", model: "test" } },
    { id: "model-done", sequence: "2", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: null,
      type: "model.completed", actor: "orchestrator", correlationId: stepId, causationId: "model-start",
      idempotencyKey: `turn:${owner.turnId}:event:model-completed:${stepId}`, payload: completionPayload },
    { id: "model-usage", sequence: "3", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: null,
      type: "model.usage", actor: "orchestrator", correlationId: stepId, causationId: "model-done",
      idempotencyKey: `turn:${owner.turnId}:event:model-usage:${stepId}`,
      payload: { taskId: owner.taskId, provider: "fixture", model: "test", usage: { inputTokens: 12, outputTokens: 3, estimatedCostUsd: 0.001 } } },
  ]
  const pause = { id: "pause-1", sequence: "4", itemId: null, taskId: null, actor: "user", correlationId: owner.turnId,
    causationId: null, idempotencyKey: "agent-session-control:pause-1", payload: { turnId: owner.turnId, expectedRevision: 4, requestedAt: "2026-09-01T00:00:04.000Z" } }
  const calls: string[] = []
  const query = vi.fn(async (sql: string) => {
    calls.push(sql)
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim()) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions" AS session')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: owner.turnId, status: "in_progress", revision: 4 }], rowCount: 1 }
    if (sql.includes('FROM "agent_steps" AS step')) return { rows: [{ id: stepId, status: "streaming", errorCode: null, finishReason: null,
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes("ANY($4::text[])")) return { rows: events, rowCount: events.length }
    if (sql.includes("session.pause_requested")) return { rows: [pause], rowCount: 1 }
    if (sql.includes('FROM "agent_items"') && sql.includes("'tool_call', 'tool_result'")) return { rows: [], rowCount: 0 }
    if (sql.includes('UPDATE "agent_steps"')) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = $2')) return { rows: [], rowCount: 0 }
    if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: "5" }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_events"') || sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
    throw new Error("unexpected_orphan_pause_query")
  })
  const client = { query, release: vi.fn() }
  return { pool: { connect: vi.fn(async () => client) }, query, calls }
}

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

  it.each([
    ["legacy", { taskId: owner.taskId, provider: "fixture", model: "test" }],
    ["counted", { taskId: owner.taskId, provider: "fixture", model: "test", toolCallCount: 0 }],
  ])("recovers paused orphan usage with a %s model completion receipt", async (_label, completionPayload) => {
    const fixture = pausedUsageFixture(completionPayload)
    await expect(recoverPausedOrphanUsage(fixture.pool as never, owner, new Date("2026-09-01T00:00:10Z"))).resolves.toBe(true)
    expect(fixture.calls.some(sql => sql.includes('UPDATE "agent_steps" SET "status" = \'interrupted\''))).toBe(true)
  })

  it("fails closed on a malformed counted orphan completion before Step writes", async () => {
    const fixture = pausedUsageFixture({ taskId: owner.taskId, provider: "fixture", model: "test", toolCallCount: -1 })
    await expect(recoverPausedOrphanUsage(fixture.pool as never, owner, new Date("2026-09-01T00:00:10Z")))
      .rejects.toMatchObject({ code: "question_receipt_malformed" })
    expect(fixture.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "agent_steps"'))).toBe(false)
  })
})
