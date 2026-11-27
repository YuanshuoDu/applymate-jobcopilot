import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnQuestionQueryClient } from "./turn-question-store-guards.js"
import { restoreToolCallState } from "./persisted-tool-call-state.js"
import { retirePreparedQuestionForSteering, QUESTION_STEERING_REFRESH_ERROR_CODE } from "./turn-question-store-steering-refresh.js"

const owner: TurnExecutionOwnerFence = { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  taskId: "root-1", rootTaskId: "root-1", ownerId: "lease-1", leaseVersion: 3, leaseExpiresAt: new Date("2026-11-27T12:00:00Z") }
const input = { question: "Which region should I prioritize?", choices: [{ label: "Berlin", value: "berlin" }] }
const callContent = { toolCallId: "call-1", toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null, input }
const resultContent = { toolCallId: "call-1", output: { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question",
  stage: "user_input", question: input.question, options: input.choices }, errorCode: null }

function fixture() {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const outboxes: unknown[] = []
  let sequence = 10
  let call = callContent, result = resultContent
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_steps"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "step-1", status: "streaming", taskId: owner.taskId, attempt: 1,
      finishReason: "tool_calls", errorCode: null, inputTokens: 31, outputTokens: 9, estimatedCostUsd: 0.004 }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_items" SET "content"')) {
      const saved = JSON.parse(String(values?.[0])) as Record<string, unknown>
      if (sql.includes("'tool_call'")) call = saved as typeof call
      else result = saved as typeof result
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('WHERE "id" = ANY($1::text[])')) return { rows: [
      { id: "call-item-1", stepId: "step-1", taskId: owner.taskId, type: "tool_call", status: "completed", revision: 2, content: call },
      { id: "result-item-1", stepId: "step-1", taskId: owner.taskId, type: "tool_result", status: "completed", revision: 3, content: result },
    ], rowCount: 2 }
    if (sql.includes("AND \"type\" = 'tool_call'")) return { rows: [{ id: "call-item-1", status: "completed", content: call, userId: owner.userId }], rowCount: 1 }
    if (sql.includes("AND \"type\" = 'tool_result'")) return { rows: [{ id: "result-item-1", status: "completed", content: result }], rowCount: 1 }
    if (sql.includes('UPDATE "agent_steps" SET "status"')) return { rows: [], rowCount: 1 }
    if (sql.includes('ORDER BY "sequence" DESC LIMIT 1')) return { rows: [{ id: "previous-event" }], rowCount: 1 }
    if (sql.includes('"idempotencyKey" = $2 FOR UPDATE')) return { rows: [], rowCount: 0 }
    if (sql.includes('UPDATE "agent_sessions" SET "eventSequence"')) return { rows: [{ eventSequence: ++sequence }], rowCount: 1 }
    if (sql.includes('INSERT INTO "agent_events"')) {
      events.push({ type: String(values?.[6]), payload: JSON.parse(String(values?.[10])) as Record<string, unknown> })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_outbox"')) { outboxes.push(JSON.parse(String(values?.[4]))); return { rows: [], rowCount: 1 } }
    throw new Error(`unexpected_refresh_query:${sql}`)
  }) }
  return { calls, client, events, outboxes, readItems: () => ({ call, result }) }
}

describe("retire a prepared question after late steering", () => {
  it("writes a closed, non-replayable tool receipt and failed Step without exposing the question", async () => {
    const f = fixture()
    await retirePreparedQuestionForSteering(f.client as unknown as TurnQuestionQueryClient, { owner, stepId: "step-1", toolCallId: "call-1", callItemId: "call-item-1",
      resultItemId: "result-item-1", usage: { inputTokens: 31, outputTokens: 9, estimatedCostUsd: 0.004 }, now: new Date("2026-11-27T11:00:00Z") })

    expect(f.calls.filter(call => call.sql.includes('UPDATE "agent_items" SET "content"'))).toHaveLength(2)
    expect(f.calls.find(call => call.sql.includes('UPDATE "agent_steps" SET "status"'))?.sql).toContain('AND "status" = \'streaming\'')
    expect(f.events.map(event => event.type)).toEqual(["tool_call.failed", "item.completed", "item.completed", "step.completed"])
    expect(f.events[0]?.payload).toMatchObject({ toolCallId: "call-1", status: "failed", errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE })
    expect(f.events[3]?.payload).toMatchObject({ stepId: "step-1", status: "failed", errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE })
    expect(f.outboxes).toHaveLength(4)
    expect(f.readItems().call).toMatchObject({ status: "failed", errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE })
    expect(f.readItems().result).toMatchObject({ output: null, errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE })
    expect(JSON.stringify({ events: f.events, outboxes: f.outboxes })).not.toContain(input.question)

    const restored = restoreToolCallState([
      { id: "call-item-1", stepId: "step-1", taskId: owner.taskId, type: "tool_call", status: "completed", revision: 3, content: f.readItems().call },
      { id: "result-item-1", stepId: "step-1", taskId: owner.taskId, type: "tool_result", status: "completed", revision: 4, content: f.readItems().result },
    ], f.events.map(event => ({ type: event.type, payload: event.payload })))
    expect(restored.pending).toEqual([])
    expect(restored.observations).toHaveLength(1)
    expect(restored.observations[0]?.content).toMatchObject({ toolCallId: "call-1", status: "failed",
      errorCode: QUESTION_STEERING_REFRESH_ERROR_CODE, output: null })
  })

  it("fails closed when the prepared pair is not the exact owner-scoped call", async () => {
    const f = fixture()
    await expect(retirePreparedQuestionForSteering(f.client as unknown as TurnQuestionQueryClient, { owner: { ...owner, taskId: "other-root", rootTaskId: "other-root" },
      stepId: "step-1", toolCallId: "call-1", callItemId: "call-item-1", resultItemId: "result-item-1",
      usage: { inputTokens: 31, outputTokens: 9, estimatedCostUsd: 0.004 }, now: new Date() })).rejects.toThrow()
    expect(f.calls.some(call => call.sql.includes("UPDATE "))).toBe(false)
  })
})
