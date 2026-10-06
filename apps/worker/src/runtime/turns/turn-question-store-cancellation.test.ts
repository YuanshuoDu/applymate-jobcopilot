import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { hasQuestionPauseEvents } from "./turn-question-store-cancellation.js"
import { questionId } from "./turn-question-store-guards.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-10-06T12:00:00.000Z"),
}

function cancellationEvents(withResult: boolean) {
  const stepId = "step-1", toolCallId = "call-1", callItemId = "call-item-1", resultItemId = withResult ? "result-item-1" : null
  const digest = questionId(owner, stepId, toolCallId), base = `turn:${owner.turnId}:event:question-pause:${digest}`
  const callId = `agent-question-pause-call-${digest}`, itemId = `agent-question-pause-item-${digest}`
  const resultId = `agent-question-pause-result-${digest}`, stepEventId = `agent-question-pause-step-${digest}`
  const rows = [
    { id: callId, itemId: callItemId, type: "tool_call.failed", actor: "orchestrator", correlationId: toolCallId, causationId: null,
      idempotencyKey: `${base}:call`, payload: { toolCallId, toolName: "agent.ask_user", status: "cancelled", errorCode: null, taskId: owner.taskId } },
    { id: itemId, itemId: callItemId, type: "item.delta", actor: "orchestrator", correlationId: callItemId, causationId: callId,
      idempotencyKey: `${base}:item`, payload: { itemId: callItemId, status: "interrupted", content: { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "cancelled", errorCode: null } } },
    ...(resultItemId ? [{ id: resultId, itemId: resultItemId, type: "item.delta", actor: "orchestrator", correlationId: resultItemId, causationId: itemId,
      idempotencyKey: `${base}:result`, payload: { itemId: resultItemId, status: "interrupted", content: { toolCallId, output: null, status: "cancelled", errorCode: null } } }] : []),
    { id: stepEventId, itemId: null, type: "step.completed", actor: "orchestrator", correlationId: stepId,
      causationId: resultItemId ? resultId : itemId, idempotencyKey: `${base}:step`,
      payload: { stepId, status: "interrupted", errorCode: "session_pause_requested", toolCallCount: 1, taskId: owner.taskId } },
  ]
  return { stepId, toolCallId, callItemId, resultItemId, rows }
}

function queryClient(rows: readonly Record<string, unknown>[]) {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as never
}

describe("native question pause cancellation readback", () => {
  it.each([false, true])("accepts the exact server event chain (result present: %s)", async withResult => {
    const fixture = cancellationEvents(withResult)
    const client = queryClient(fixture.rows)
    await expect(hasQuestionPauseEvents(client, owner, fixture.stepId, fixture.toolCallId, fixture.callItemId, fixture.resultItemId)).resolves.toBe(true)
  })

  it("fails closed for missing, duplicate, or altered server cancellation events", async () => {
    const fixture = cancellationEvents(false)
    await expect(hasQuestionPauseEvents(queryClient(fixture.rows.slice(0, 2)), owner, fixture.stepId, fixture.toolCallId, fixture.callItemId, null)).resolves.toBe(false)
    await expect(hasQuestionPauseEvents(queryClient([...fixture.rows, fixture.rows[0]!]), owner, fixture.stepId, fixture.toolCallId, fixture.callItemId, null)).resolves.toBe(false)
    const forged = fixture.rows.map(row => row.type === "tool_call.failed" ? { ...row, payload: { ...row.payload, status: "failed" } } : row)
    await expect(hasQuestionPauseEvents(queryClient(forged), owner, fixture.stepId, fixture.toolCallId, fixture.callItemId, null)).resolves.toBe(false)
  })
})
