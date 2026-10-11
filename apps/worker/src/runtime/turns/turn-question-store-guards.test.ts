import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { assertQuestionOwner, assertQuestionUsage, completedQuestionResult, questionId, questionItemId,
  type TurnQuestionQueryClient, type TurnQuestionReadIdentity } from "./turn-question-store-guards.js"
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
})
