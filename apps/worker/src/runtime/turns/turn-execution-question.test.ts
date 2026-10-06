import { describe, expect, it, vi } from "vitest"

import { SessionPauseRequestedError } from "../session-gate.js"
import { TurnQuestionStoreError, type TurnQuestionStore } from "./turn-question-contract.js"
import { nativeQuestionCallId, nativeQuestionResultMatches, questionWaitResult, recoverableNativeQuestionCalls, recoverPendingNativeQuestion } from "./turn-execution-question.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"

const identity = { kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 3, leaseExpiresAt: new Date("2026-10-06T12:00:00.000Z") }
const output = {
  text: "", reasoningSummary: "", finishReason: "tool_calls" as const, provider: "fixture", model: "fixture", continuation: null,
  usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 }, toolCalls: [{ id: "call-1", name: "agent.ask_user", arguments: { question: "Which city?", choices: [{ label: "Berlin", value: "berlin" }] } }],
}
const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input", question: "Which city?", options: [{ label: "Berlin", value: "berlin" }] }

function options(store: Partial<TurnQuestionStore> = {}): TurnExecutionOptions {
  return { identity, store, signal: new AbortController().signal } as never
}

describe("native question runtime decisions", () => {
  it("accepts only one isolated root question call with real usage", () => {
    expect(nativeQuestionCallId(output, identity)).toBe("call-1")
    expect(() => nativeQuestionCallId({ ...output, usage: null }, identity)).toThrow()
    expect(() => nativeQuestionCallId({ ...output, toolCalls: [...output.toolCalls, { id: "call-2", name: "jobs.search", arguments: {} }] }, identity)).toThrow()
    expect(() => nativeQuestionCallId(output, { ...identity, taskId: "child-1", kind: "task" } as never)).toThrow()
  })

  it("checks the completed receipt against the exact normalized tool input", () => {
    expect(nativeQuestionResultMatches(output.toolCalls[0]?.arguments, intent)).toBe(true)
    expect(nativeQuestionResultMatches(output.toolCalls[0]?.arguments, { ...intent, question: "Different question" })).toBe(false)
    expect(nativeQuestionResultMatches(output.toolCalls[0]?.arguments, { ...intent, privateOwner: "user-1" })).toBe(false)
  })

  it("commits a prepared receipt before model work and returns an existing wait", async () => {
    const waitForQuestion = vi.fn(async () => ({ status: "waiting_for_user" as const, disposition: "created" as const, waitId: "question-1", itemId: "agent-wait:question:question-1", turnId: identity.turnId, toolCallId: "call-1", nextTurnRevision: 2 }))
    const prepared = await recoverPendingNativeQuestion(options({
      readPendingQuestion: async () => ({ status: "prepared", stepId: "step-1", toolCallId: "call-1", waitId: "question-1", itemId: "agent-wait:question:question-1" }),
      waitForQuestion,
    }), () => new Date(), 2, 1)
    expect(prepared).toEqual({ status: "waiting_for_user", waitId: "question-1", stepCount: 2, toolCallCount: 1 })
    expect(waitForQuestion).toHaveBeenCalledWith({ identity, stepId: "step-1", toolCallId: "call-1", now: expect.any(Date) })

    const waiting = await recoverPendingNativeQuestion(options({ readPendingQuestion: async () => ({ status: "waiting", stepId: "step-1", toolCallId: "call-1", waitId: "question-1", itemId: "item-1", turnId: identity.turnId }) }), () => new Date(), 2, 1)
    expect(waiting).toEqual({ status: "waiting_for_user", waitId: "question-1", stepCount: 2, toolCallCount: 1 })
  })

  it("lets answered questions use loaded answer history and blocks closed or stale questions", async () => {
    await expect(recoverPendingNativeQuestion(options({ readPendingQuestion: async () => ({ status: "answered", stepId: "step-1", toolCallId: "call-1", waitId: "q1", itemId: "i1", turnId: identity.turnId }) }), () => new Date(), 1, 1)).resolves.toBeNull()
    await expect(recoverPendingNativeQuestion(options({ readPendingQuestion: async () => ({ status: "closed", stepId: "step-1", toolCallId: "call-1", waitId: "q1", itemId: "i1", turnId: identity.turnId }) }), () => new Date(), 1, 1)).rejects.toMatchObject({ code: "question_not_current" })
    await expect(recoverPendingNativeQuestion(options({ readPendingQuestion: async () => ({ status: "not_current" }) }), () => new Date(), 1, 1)).rejects.toMatchObject({ code: "question_not_current" })
  })

  it("skips only a confirmed pre-intent paused ask replay", async () => {
    const replay = { action: "replay", stepId: "step-1", toolVersion: "1", call: { id: "call-1", name: "agent.ask_user", arguments: output.toolCalls[0]?.arguments }, durableResult: null }
    const ordinary = { action: "replay", stepId: "step-1", toolVersion: "1", call: { id: "call-2", name: "jobs.search", arguments: {} }, durableResult: null }
    const readPendingQuestion = vi.fn(async () => ({ status: "none" as const }))
    await expect(recoverableNativeQuestionCalls(options({ readPendingQuestion }), [replay, ordinary] as never, () => new Date())).resolves.toEqual([ordinary])
    expect(readPendingQuestion).toHaveBeenCalledOnce()
    const malformed = options({ readPendingQuestion: async () => { throw new TurnQuestionStoreError("question_receipt_malformed", "Malformed question receipt") } })
    await expect(recoverableNativeQuestionCalls(malformed, [replay] as never, () => new Date())).rejects.toMatchObject({ code: "question_receipt_malformed" })
    await expect(recoverableNativeQuestionCalls(options({ readPendingQuestion: async () => ({ status: "prepared", stepId: "step-1", toolCallId: "call-1", waitId: "q1", itemId: "i1" }) }), [replay] as never, () => new Date())).resolves.toEqual([replay])
  })

  it("retries uncertain wait commits without converting pause or owner fences", async () => {
    const failed = options({ waitForQuestion: async () => { throw new Error("temporary database failure") } })
    await expect(questionWaitResult(failed, "step-1", "call-1", () => new Date(), 1, 1)).rejects.toMatchObject({ code: "prepared_question_wait_retry_required" })
    const pause = new SessionPauseRequestedError()
    await expect(questionWaitResult(options({ waitForQuestion: async () => { throw pause } }), "step-1", "call-1", () => new Date(), 1, 1)).rejects.toBe(pause)
    const lost = new Error("lost lease")
    await expect(questionWaitResult({ ...options({ waitForQuestion: async () => { throw lost } }), isOwnershipLost: () => true }, "step-1", "call-1", () => new Date(), 1, 1)).rejects.toBe(lost)
  })
})
