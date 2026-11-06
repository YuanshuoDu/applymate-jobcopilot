import { describe, expect, it } from "vitest"
import {
  CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL,
  isCanonicalWaitResultPair,
  partitionWaitResultEvents,
} from "./pg-store-expiry-step-completion-proof.js"

const task = { id: "task-1", sessionId: "session-1", turnId: "turn-1" }
const resultItemId = "task:task-1:item:tool-result:call-1:attempt:2"
const stepId = "task:task-1:step:4:attempt:2"
const resultStarted = { id: "result-started", sequence: "11", type: "item.started", actor: "subagent", itemId: resultItemId,
  correlationId: stepId, causationId: "call-finished", idempotencyKey: `task:task-1:event:item-started:${resultItemId}`,
  payload: { itemId: resultItemId, type: "tool_result", phase: null } }
const resultCompleted = { id: "result-completed", sequence: "12", type: "item.completed", actor: "subagent", itemId: resultItemId,
  correlationId: resultItemId, causationId: resultStarted.id,
  idempotencyKey: `task:task-1:event:tool-result-completed:call-1:${resultItemId}:1`,
  payload: { itemId: resultItemId, status: "completed", content: { toolCallId: "call-1", output: { status: "waiting" }, errorCode: null } } }
const stepCompleted = { id: "step-completed", sequence: "13", type: "step.completed", actor: "subagent", itemId: null,
  correlationId: stepId, causationId: resultCompleted.id, idempotencyKey: `task:task-1:event:step-completed:${stepId}`,
  payload: { stepId, status: "completed", toolCallCount: 1, taskId: task.id } }
const model = { id: "model-completed", sequence: "9", type: "model.completed", actor: "subagent", itemId: null,
  correlationId: stepId, idempotencyKey: `task:task-1:event:model-completed:${stepId}`,
  payload: { taskId: task.id, provider: "test-provider", model: "test-model", toolCallCount: 1 } }

const unparenthesizedJsonExtractionAfterConcat = /\|\|\s*(?:[a-z_][\w]*\.)?(?:"[^"]+"|[a-z_][\w]*)(?:\s*->>?\s*(?:'[^']+'|"[^"]+"))+/i

describe("wait claim result event set", () => {
  it("parenthesizes JSON text extraction operands in PostgreSQL concatenation", () => {
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).not.toMatch(unparenthesizedJsonExtractionAfterConcat)
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain("jsonb_array_length(CASE WHEN jsonb_typeof(proof.value->'stepToolChain'->'events') = 'array'")
    expect(CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL).toContain("jsonb_array_length(CASE WHEN jsonb_typeof(proof.value->'stepToolChain'->'calls') = 'array'")
  })

  it("selects only one canonical pair and at most one direct descendant", () => {
    expect(partitionWaitResultEvents([resultStarted, resultCompleted], [resultStarted.idempotencyKey, resultCompleted.idempotencyKey]))
      .toEqual({ started: resultStarted, completed: resultCompleted })
    expect(partitionWaitResultEvents([resultStarted, resultCompleted, stepCompleted], [resultStarted.idempotencyKey, resultCompleted.idempotencyKey]))
      .toEqual({ started: resultStarted, completed: resultCompleted, extra: stepCompleted })
    expect(partitionWaitResultEvents([resultStarted, resultCompleted, stepCompleted, stepCompleted], [resultStarted.idempotencyKey, resultCompleted.idempotencyKey]))
      .toBeNull()
    expect(partitionWaitResultEvents([resultStarted, resultStarted], [resultStarted.idempotencyKey, resultCompleted.idempotencyKey])).toBeNull()
  })

  it("validates the canonical result event order and exact writer payloads", () => {
    expect(isCanonicalWaitResultPair({ id: "call-finished", sequence: "10", type: "tool_call.completed" }, resultStarted,
      resultCompleted, resultItemId, stepId, resultCompleted.payload.content)).toBe(true)
    expect(isCanonicalWaitResultPair({ id: "call-finished", sequence: "12", type: "tool_call.completed" }, resultStarted,
      resultCompleted, resultItemId, stepId, resultCompleted.payload.content)).toBe(false)
    expect(isCanonicalWaitResultPair({ id: "call-finished", sequence: "10", type: "tool_call.completed" }, resultStarted,
      { ...resultCompleted, payload: { ...resultCompleted.payload, status: "failed" } }, resultItemId, stepId, resultCompleted.payload.content)).toBe(false)
  })
})
