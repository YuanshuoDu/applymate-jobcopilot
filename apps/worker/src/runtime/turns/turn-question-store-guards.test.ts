import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { assertQuestionOwner, assertQuestionUsage, completedQuestionResult, questionId, questionItemId,
  questionConflict, recoverIncompleteQuestionCall, type TurnQuestionQueryClient, type TurnQuestionReadIdentity } from "./turn-question-store-guards.js"
import { TurnQuestionStoreError, type TurnQuestionUsageInput } from "./turn-question-contract.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-01T00:01:00Z"),
}
const usageInput: TurnQuestionUsageInput = {
  owner, stepId: "step-1", toolCallId: "call-1", finishReason: "tool_calls",
  usage: { inputTokens: 120, outputTokens: 15, estimatedCostUsd: 0.002 }, now: new Date("2026-09-01T00:00:10Z"),
}

describe("native question persistence guards", () => {
  it("accepts only the root Turn fence and stable bounded usage", () => {
    expect(() => assertQuestionOwner(owner)).not.toThrow()
    expect(() => assertQuestionUsage(usageInput)).not.toThrow()
    expect(questionId(owner, "step-1", "call-1")).toMatch(/^[a-f0-9]{64}$/)
    expect(questionId(owner, "step-1", "call-1")).toBe(questionId(owner, "step-1", "call-1"))
    expect(questionId(owner, "step-1", "call-1")).not.toBe(questionId(owner, "step-2", "call-1"))
    expect(questionItemId(questionId(owner, "step-1", "call-1"))).toBe(`agent-wait:question:${questionId(owner, "step-1", "call-1")}`)
  })

  it.each(["+353 87 123 4567", "alex@example.com", "sk_live_secret_token_abc"])("keeps conflict diagnostics safe for opaque call ID %s", id => {
    const error = questionConflict(`tool call ${id} lineage`)
    expect(error).toBeInstanceOf(TurnQuestionStoreError)
    expect(error.code).toBe("question_conflict")
    expect(error.message).toBe("Question persistence conflict: tool_call")
    expect(error.message).not.toContain(id)
  })

  it("does not echo an arbitrary conflict resource when no safe category matches", () => {
    const error = questionConflict("secret arbitrary input should never be logged")
    expect(error.message).toBe("Question persistence conflict: state")
    expect(error.message).not.toContain("secret arbitrary input")
  })

  it("derives historical question identity and reads a strict receipt without a live lease", async () => {
    const readIdentity: TurnQuestionReadIdentity = { sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId }
    const callIntent = { question: "Where should the search focus?", choices: [{ label: "Dublin", value: "dublin" }] }
    const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input",
      question: callIntent.question, options: callIntent.choices }
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "call-item", status: "completed", content: {
        toolCallId: "call-1", toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null,
        input: callIntent,
      } }] })
      .mockResolvedValueOnce({ rows: [{ id: "result-item", status: "completed", content: {
        toolCallId: "call-1", output: intent, errorCode: null,
      } }] })
    const client = { query } as unknown as TurnQuestionQueryClient

    expect(questionId({ sessionId: readIdentity.sessionId, turnId: readIdentity.turnId }, "step-1", "call-1"))
      .toBe(questionId(owner, "step-1", "call-1"))
    await expect(completedQuestionResult(client, readIdentity, "step-1", "call-1"))
      .resolves.toMatchObject({ callItemId: "call-item", resultItemId: "result-item", intent })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("rejects child, unrooted, malformed, and unavailable usage instead of silently defaulting", () => {
    expect(() => assertQuestionOwner({ ...owner, kind: "task", taskId: "child-1" } as unknown as TurnExecutionOwnerFence)).toThrow(TurnQuestionStoreError)
    expect(() => assertQuestionOwner({ ...owner, rootTaskId: "other-root" })).toThrow(/current native root owner/)
    expect(() => assertQuestionUsage({ ...usageInput, usage: { ...usageInput.usage, outputTokens: Number.NaN } })).toThrow(/usage is invalid/)
    expect(() => assertQuestionUsage({ ...usageInput, finishReason: "" })).toThrow(/usage is invalid/)
    expect(() => assertQuestionUsage({ ...usageInput, now: new Date(Number.NaN) })).toThrow(/usage is invalid/)
  })

  it.each([
    ["legacy receipt", { taskId: owner.taskId, provider: "fixture", model: "test" }],
    ["counted receipt", { taskId: owner.taskId, provider: "fixture", model: "test", toolCallCount: 1 }],
  ])("recovers an exact incomplete ask_user call with a %s", async (_label, completionPayload) => {
    const stepId = "step-1", toolCallId = "call-1"
    const argumentsValue = { question: "Where should the search focus?", choices: [{ label: "Dublin", value: "dublin" }] }
    const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input",
      question: argumentsValue.question, options: argumentsValue.choices }
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
    const query = vi.fn(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim()) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions" AS session')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: owner.turnId, status: "in_progress", revision: 4 }], rowCount: 1 }
      if (sql.includes('FROM "agent_items" AS callItem')) return { rows: [{
        callItemId: "call-item", stepId, callStatus: "completed", callContent: { toolCallId, toolName: "agent.ask_user", toolVersion: "1",
          status: "completed", errorCode: null, input: argumentsValue }, stepStatus: "streaming", stepErrorCode: null, finishReason: null,
        inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, resultItemId: "result-item", resultStatus: "started", resultCount: "1",
        resultContent: { toolCallId, output: intent, errorCode: null },
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps" WHERE')) return { rows: [{ id: stepId, status: "streaming", taskId: owner.taskId, attempt: 1,
        finishReason: null, errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"') && sql.includes("ANY($5::text[])")) return { rows: events, rowCount: events.length }
      if (sql.includes("session.pause_requested")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id" FROM "agent_items"')) return { rows: [], rowCount: 0 }
      if (sql.includes("UPDATE \"agent_steps\"")) return { rows: [], rowCount: 1 }
      throw new Error("unexpected_question_recovery_query")
    })
    const client = { query, release: vi.fn() }
    const pool = { connect: vi.fn(async () => client) }

    await expect(recoverIncompleteQuestionCall(pool as never, owner, new Date("2026-09-01T00:00:10Z")))
      .resolves.toMatchObject({ status: "replayable", stepId, toolCallId })
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE \"agent_steps\""))).toBe(true)
  })

  it.each([
    ["negative count", { taskId: owner.taskId, provider: "fixture", model: "test", toolCallCount: -1 }],
    ["extra field", { taskId: owner.taskId, provider: "fixture", model: "test", toolCallCount: 1, extra: true }],
  ])("rejects an ask_user %s before restoring the Step", async (_label, completionPayload) => {
    const stepId = "step-1", toolCallId = "call-1"
    const argumentsValue = { question: "Where should the search focus?", choices: [{ label: "Dublin", value: "dublin" }] }
    const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input",
      question: argumentsValue.question, options: argumentsValue.choices }
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
    const query = vi.fn(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim()) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions" AS session')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: owner.turnId, status: "in_progress", revision: 4 }], rowCount: 1 }
      if (sql.includes('FROM "agent_items" AS callItem')) return { rows: [{
        callItemId: "call-item", stepId, callStatus: "completed", callContent: { toolCallId, toolName: "agent.ask_user", toolVersion: "1",
          status: "completed", errorCode: null, input: argumentsValue }, stepStatus: "streaming", stepErrorCode: null, finishReason: null,
        inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, resultItemId: "result-item", resultStatus: "started", resultCount: "1",
        resultContent: { toolCallId, output: intent, errorCode: null },
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps" WHERE')) return { rows: [{ id: stepId, status: "streaming", taskId: owner.taskId, attempt: 1,
        finishReason: null, errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"') && sql.includes("ANY($5::text[])")) return { rows: events, rowCount: events.length }
      if (sql.includes("session.pause_requested")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id" FROM "agent_items"')) return { rows: [], rowCount: 0 }
      throw new Error("unexpected_question_recovery_query")
    })
    const client = { query, release: vi.fn() }, pool = { connect: vi.fn(async () => client) }

    await expect(recoverIncompleteQuestionCall(pool as never, owner, new Date("2026-09-01T00:00:10Z")))
      .rejects.toMatchObject({ code: "question_usage_unavailable" })
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE \"agent_steps\""))).toBe(false)
  })
})
