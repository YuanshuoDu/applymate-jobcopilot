import { describe, expect, it, vi } from "vitest"

import { SessionPauseRequestedError } from "../session-gate.js"
import { TurnQuestionStoreError, type TurnQuestionStore } from "./turn-question-contract.js"
import { executeNativeQuestionTool, isTurnStateRefreshRetryError, nativeQuestionCallId, nativeQuestionResultCall, nativeQuestionResultMatches, questionWaitResult, readPendingNativeQuestion, recoverableNativeQuestionCalls, recoverPendingNativeQuestion } from "./turn-execution-question.js"
import { OrphanPauseUsageRecoveredError } from "./turn-question-store-events.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { createToolRouterExecutor } from "./turn-engine-helpers.js"
import { createAskUserTool } from "../tools/ask-user.js"
import { InMemoryToolLifecycleSink, ToolLifecycle } from "../tools/lifecycle.js"
import { InMemoryToolResultReferenceStore } from "../tools/redaction.js"
import { ToolRegistry } from "../tools/registry.js"
import { ToolRouter } from "../tools/router.js"
import { PolicyEngine } from "../policy/index.js"
import type { RuntimeToolDefinition } from "../tools/types.js"

const identity = { kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 3, leaseExpiresAt: new Date("2026-10-06T12:00:00.000Z") }
const output = {
  text: "", reasoningSummary: "", finishReason: "tool_calls" as const, provider: "fixture", model: "fixture", continuation: null,
  usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 }, toolCalls: [{ id: "call-1", name: "agent.ask_user", arguments: { question: "Which city?", choices: [{ label: "Berlin", value: "berlin" }] } }],
}
const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input", question: "Which city?", options: [{ label: "Berlin", value: "berlin" }] } as const
const nativeQuestionPolicy = new PolicyEngine({ snapshot: { version: "policy.v1", rules: [{
  id: "native-question-test", roles: ["orchestrator"], tools: ["agent.ask_user"], toolVersions: ["1"],
  risks: ["internal_write"], domains: ["coordination"], requiredCapabilities: ["canManageChildren"],
  outcome: "allow", reasonCode: "native_question_test", reason: "Allow the built-in native question in this test",
}] } })

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

  it("carries only branded Router evidence to private storage and keeps event projections redacted", async () => {
    const storedItems = new Map<string, unknown>(), eventPayloads: unknown[] = [], subscriberPayloads: unknown[] = []
    const store: TurnExecutionStore = {
      startStep: async ({ ordinal }) => ({ id: "step-1", ordinal }), updateStep: async () => undefined,
      createItem: async ({ itemId, content }) => { storedItems.set(itemId, content); return { id: itemId, revision: 0 } },
      updateItem: async ({ itemId, expectedRevision, content }) => {
        storedItems.set(itemId, content)
        return { id: itemId, revision: expectedRevision + 1 }
      },
      appendEvent: async ({ id, payload }) => { eventPayloads.push(payload); return { id } },
      stageQuestionUsage: async () => undefined,
    }
    const lifecycleSink = new InMemoryToolLifecycleSink()
    const router = new ToolRouter(new ToolRegistry([createAskUserTool() as RuntimeToolDefinition]), new ToolLifecycle({
      sink: lifecycleSink, references: new InMemoryToolResultReferenceStore(),
    }), nativeQuestionPolicy)
    const executionOptions: TurnExecutionOptions = {
      ...options(),
      scope: { userId: identity.userId }, actorRole: "orchestrator", capabilities: ["canManageChildren"],
      executeTool: createToolRouterExecutor(router), store,
      subscribe: event => { subscriberPayloads.push(event.payload) }, idFactory: prefix => prefix,
    }
    const writer = new TurnExecutionEventWriter(executionOptions)
    const call = output.toolCalls[0]!
    const result = await executeNativeQuestionTool(executionOptions, writer, { id: "step-1", ordinal: 0 }, call, output,
      () => new Date("2026-11-05T12:00:00Z"), vi.fn())

    expect(nativeQuestionResultCall(identity, "step-1", call, result)).toEqual({ stepId: "step-1", toolCallId: "call-1" })
    const callItem = [...storedItems.values()].find(value => JSON.stringify(value).includes('"toolName":"agent.ask_user"'))
    const resultItem = [...storedItems.values()].find(value => JSON.stringify(value).includes('"nativeQuestionAttestation"'))
    expect(JSON.stringify(callItem)).toContain("Which city?")
    expect(JSON.stringify(resultItem)).toContain("nativeQuestionAttestation")
    expect(JSON.stringify(resultItem)).not.toContain("Which city?")
    expect(JSON.stringify(resultItem)).not.toContain("berlin")
    const projected = JSON.stringify({ eventPayloads, subscriberPayloads, lifecycle: lifecycleSink.events })
    expect(projected).not.toContain("Which city?")
    expect(projected).not.toContain("berlin")
    expect(projected).not.toContain("nativeQuestionAttestation")
  })

  it.each(["failed", "cancelled"] as const)("drops untrusted %s output before persistence and publication", async status => {
    const persisted: unknown[] = [], projected: unknown[] = []
    const sensitiveOutput = { question: intent.question, choices: intent.options }
    const executionOptions: TurnExecutionOptions = {
      ...options({ stageQuestionUsage: async () => undefined }),
      executeTool: async () => ({ id: "call-1", toolName: "agent.ask_user", toolVersion: "1", status,
        output: sensitiveOutput, errorCode: status === "cancelled" ? "cancelled" : "tool_execution_failed" }),
      store: {
        createItem: async (input: Parameters<TurnExecutionStore["createItem"]>[0]) => { persisted.push(input.content); return { id: input.itemId, revision: 0 } },
        updateItem: async (input: Parameters<TurnExecutionStore["updateItem"]>[0]) => { persisted.push(input.content); return { id: input.itemId, revision: input.expectedRevision + 1 } },
        appendEvent: async (input: Parameters<TurnExecutionStore["appendEvent"]>[0]) => { projected.push(input.payload); return { id: input.id } },
        stageQuestionUsage: async () => undefined,
      } as unknown as TurnExecutionStore,
      subscribe: event => { projected.push(event.payload) },
      idFactory: prefix => prefix,
    } as TurnExecutionOptions
    const result = await executeNativeQuestionTool(executionOptions, new TurnExecutionEventWriter(executionOptions),
      { id: "step-1", ordinal: 0 }, output.toolCalls[0]!, output, () => new Date("2026-11-05T12:00:00Z"), vi.fn())

    expect(result).toMatchObject({ status, output: null })
    const resultOutputs = persisted.flatMap(value => value && typeof value === "object" && Object.hasOwn(value, "output")
      ? [(value as Record<string, unknown>).output] : [])
    expect(resultOutputs).toEqual([null, null])
    expect(JSON.stringify(projected)).not.toContain(intent.question)
    expect(JSON.stringify(projected)).not.toContain("berlin")
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
    await expect(recoverableNativeQuestionCalls(options(), [replay] as never, () => new Date()))
      .rejects.toMatchObject({ code: "turn_state_refresh_retry_required" })
    await expect(recoverableNativeQuestionCalls(options({ readPendingQuestion: async () => ({ status: "prepared", stepId: "step-1", toolCallId: "call-1", waitId: "q1", itemId: "i1" }) }), [replay] as never, () => new Date()))
      .rejects.toMatchObject({ code: "turn_state_refresh_retry_required" })
  })

  it("replays only the exact durable incomplete ask_user call before terminal question preflight", async () => {
    const replay = { action: "replay", stepId: "step-1", toolVersion: "1", call: { id: "call-1", name: "agent.ask_user", arguments: output.toolCalls[0]?.arguments }, callItem: { id: "call-item-1", revision: 0 } }
    const pending = { status: "replayable" as const, stepId: "step-1", toolCallId: "call-1", callItemId: "call-item-1", intent }
    await expect(recoverableNativeQuestionCalls(options({ readPendingQuestion: async () => pending }), [replay] as never, () => new Date())).resolves.toEqual([replay])
    await expect(recoverableNativeQuestionCalls(options({ readPendingQuestion: async () => pending }), [{ ...replay, stepId: "other-step" }] as never, () => new Date()))
      .rejects.toMatchObject({ code: "turn_state_refresh_retry_required" })
    await expect(recoverableNativeQuestionCalls(options({ readPendingQuestion: async () => pending }), [replay, {
      ...replay, call: { ...replay.call, id: "call-2" }, callItem: { id: "call-item-2", revision: 0 },
    }] as never, () => new Date())).rejects.toMatchObject({ code: "turn_state_refresh_retry_required" })
    await expect(recoverPendingNativeQuestion(options({ readPendingQuestion: async () => pending }), () => new Date(), 0, 0))
      .rejects.toMatchObject({ code: "turn_state_refresh_retry_required" })
  })

  it.each([
    ["missing output", undefined],
    ["null output", null],
    ["server redaction placeholder", { question: "[REDACTED]", choices: [] }],
    ["exact legacy intent", intent],
  ] as const)("replays a durable completed ask_user only after owner-fenced recovery for %s", async (_label, safeOutput) => {
    const reconciliation = { action: "reconcile", stepId: "step-1", toolVersion: "1", callItem: { id: "call-item-1", revision: 0 },
      call: { id: "call-1", name: "agent.ask_user", arguments: output.toolCalls[0]?.arguments },
      durableResult: { id: "call-1", toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null,
        ...(safeOutput === undefined ? {} : { output: safeOutput }) } }
    const pending = { status: "replayable" as const, stepId: "step-1", toolCallId: "call-1", callItemId: "call-item-1", intent }
    const recovered = await recoverableNativeQuestionCalls(options({ readPendingQuestion: async () => pending }), [reconciliation] as never, () => new Date())
    expect(recovered[0]).toMatchObject({ action: "replay" })
  })

  it("rejects a mismatched durable ask_user output before replay", async () => {
    const reconciliation = { action: "reconcile", stepId: "step-1", toolVersion: "1", callItem: { id: "call-item-1", revision: 0 },
      call: { id: "call-1", name: "agent.ask_user", arguments: output.toolCalls[0]?.arguments },
      durableResult: { id: "call-1", toolName: "agent.ask_user", toolVersion: "1", status: "completed", output: { ...intent, question: "Different?" }, errorCode: null } }
    const pending = { status: "replayable" as const, stepId: "step-1", toolCallId: "call-1", callItemId: "call-item-1", intent }
    await expect(recoverableNativeQuestionCalls(options({ readPendingQuestion: async () => pending }), [reconciliation] as never, () => new Date()))
      .rejects.toMatchObject({ code: "turn_state_refresh_retry_required" })
  })

  it("retries uncertain wait commits without converting pause or owner fences", async () => {
    const failed = options({ waitForQuestion: async () => { throw new Error("temporary database failure") } })
    await expect(questionWaitResult(failed, "step-1", "call-1", () => new Date(), 1, 1)).rejects.toMatchObject({ code: "prepared_question_wait_retry_required" })
    const pause = new SessionPauseRequestedError()
    await expect(questionWaitResult(options({ waitForQuestion: async () => { throw pause } }), "step-1", "call-1", () => new Date(), 1, 1)).rejects.toBe(pause)
    const lost = new Error("lost lease")
    await expect(questionWaitResult({ ...options({ waitForQuestion: async () => { throw lost } }), isOwnershipLost: () => true }, "step-1", "call-1", () => new Date(), 1, 1)).rejects.toBe(lost)
  })
  it("requests a canonical state refresh after orphan usage is durably repaired", async () => {
    const retry = await readPendingNativeQuestion(options({ readPendingQuestion: async () => { throw new OrphanPauseUsageRecoveredError() } }), () => new Date())
      .then(() => null, error => error as unknown)
    expect(isTurnStateRefreshRetryError(retry)).toBe(true)
    expect(retry).toMatchObject({ code: "turn_state_refresh_retry_required" })
  })
})
