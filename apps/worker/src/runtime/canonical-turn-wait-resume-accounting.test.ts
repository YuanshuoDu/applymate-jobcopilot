import { describe, expect, it } from "vitest"
import { buildCanonicalTurnResumeState } from "./canonical-turn-wait-resume-accounting.js"
import type { RecoveredArchivedWaitControl } from "./turns/turn-execution-wait.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const recovered = {
  waitId: "wait-1", status: "waiting", stepId: "step-1", stepStatus: "streaming", finishReason: "tool_calls", errorCode: null,
  inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003, toolCallCount: 3, persistedToolCallCount: 1,
  usageDelta: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 }, stepCompletionRecorded: false, canonicalOutcomeResolved: false,
} satisfies RecoveredArchivedWaitControl
const call = { id: "call-item", type: "tool_call", status: "completed", stepId: "step-1", taskId: scope.rootTaskId,
  content: { toolCallId: "wait-call", toolName: "agent.wait", input: { taskIds: ["child-1"], mode: "all" }, status: "completed" } }
const result = { id: "result-item", type: "tool_result", status: "completed", stepId: "step-1", taskId: scope.rootTaskId,
  content: { toolCallId: "wait-call", output: { $ref: "tool-result-1", sizeBytes: 9_000, sha256: "a".repeat(64) } } }
const archivedStep = { id: "step-1", taskId: scope.rootTaskId, ordinal: 4, status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 }
const archivedEvents: Array<Record<string, unknown>> = [
  { id: "start", type: "model.started", actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, itemId: null, correlationId: "step-1", idempotencyKey: "turn:turn-1:event:model-started:step-1", sequence: "1",
    payload: { taskId: scope.rootTaskId, provider: "fixture", model: "test" } },
  { id: "done", type: "model.completed", actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, itemId: null, correlationId: "step-1", causationId: "start",
    idempotencyKey: "turn:turn-1:event:model-completed:step-1", sequence: "2",
    payload: { taskId: scope.rootTaskId, provider: "fixture", model: "test", toolCallCount: 3 } },
  { id: "usage", type: "model.usage", actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, itemId: null, correlationId: "step-1", causationId: "done",
    idempotencyKey: "turn:turn-1:event:model-usage:step-1", sequence: "3",
    payload: { taskId: scope.rootTaskId, provider: "fixture", model: "test", usage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 } } },
  { id: "call-finished", type: "tool_call.completed", actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, itemId: "call-item", correlationId: "wait-call", idempotencyKey: "turn:turn-1:event:tool-finished:wait-call", sequence: "4",
    payload: { taskId: scope.rootTaskId, toolCallId: "wait-call", toolName: "agent.wait", status: "completed" } },
  { id: "step-completed", type: "step.completed", actor: "orchestrator", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, itemId: null, correlationId: "step-1", idempotencyKey: "turn:turn-1:event:step-completed:step-1", sequence: "5",
    payload: { stepId: "step-1", status: "waiting_for_dependency", toolCallCount: 3, taskId: scope.rootTaskId } },
]

function twoCallArchivedState() {
  const createdAt = new Date("2026-10-11T12:00:00.000Z")
  const priorId = "prior-call"
  const waitCall = { ...call, id: "a-wait-call-item", createdAt }
  const waitResult = { ...result, id: "b-wait-result-item", createdAt }
  const priorCall = { ...call, id: "y-prior-call-item", createdAt,
    content: { toolCallId: priorId, toolName: "agent.plan", input: {}, status: "completed" } }
  const priorResult = { ...result, id: "z-prior-result-item", createdAt,
    content: { toolCallId: priorId, output: { planned: true } } }
  const waitFinished = archivedEvents.find(event => event.type === "tool_call.completed")!
  const priorFinished = { ...waitFinished, id: "prior-finished", itemId: priorCall.id, correlationId: priorId,
    idempotencyKey: `turn:${scope.turnId}:event:tool-finished:${priorId}`, sequence: "4",
    payload: { taskId: scope.rootTaskId, toolCallId: priorId, toolName: "agent.plan", status: "completed" } }
  const finishedWait = { ...waitFinished, itemId: waitCall.id, sequence: "5" }
  const stepCompleted = { ...archivedEvents.find(event => event.type === "step.completed")!, sequence: "6" }
  const events = [...archivedEvents.filter(event => event.type !== "tool_call.completed" && event.type !== "step.completed"),
    priorFinished, finishedWait, stepCompleted]
  // Equal item timestamps and lexical IDs put the wait before its earlier executed call.
  return { items: [waitCall, waitResult, priorCall, priorResult], events }
}

function build(input: {
  steps?: readonly Record<string, unknown>[]; items?: readonly Record<string, unknown>[]; events?: readonly Record<string, unknown>[]
  persistedToolCallCount?: number; recoveredWaitControl?: RecoveredArchivedWaitControl
}) {
  return buildCanonicalTurnResumeState({ last: { ordinal: 4, inputThroughSequence: "8", consumedInputIds: ["input-1"] }, maxOrdinal: 4,
    steps: input.steps ?? [{ ...archivedStep }], items: input.items ?? [call, result], events: input.events ?? archivedEvents,
    persistedToolCallCount: input.persistedToolCallCount ?? 1, scope, recoveredWaitControl: input.recoveredWaitControl })
}

describe("canonical resume accounting for archived waits", () => {
  it("adds the full-minus-prefix suffix and usage once during the first pre-close recovery", () => {
    const streaming = { ...archivedStep, status: "streaming", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    const resumed = build({ steps: [streaming], events: archivedEvents.slice(0, 4), recoveredWaitControl: recovered })
    expect(resumed).toEqual({ nextOrdinal: 5, stepCount: 1, toolCallCount: 3, inputThroughSequence: 8n, consumedInputIds: ["input-1"],
      usage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 } })
  })

  it("retains an already-closed wait batch after a later Step becomes current", () => {
    const resumed = build({ steps: [archivedStep, { id: "step-2", ordinal: 5, status: "running", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }] })
    expect(resumed?.toolCallCount).toBe(3)
    expect(resumed?.usage).toEqual({ inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 })
  })

  it("orders a tied-item closed prefix by exact finish receipts before retaining the full count", () => {
    const value = twoCallArchivedState()
    expect(value.items.filter(item => item.type === "tool_call").map(item => item.content.toolCallId)).toEqual(["wait-call", "prior-call"])
    const resumed = build({ items: value.items, events: value.events, persistedToolCallCount: 2 })
    expect(resumed?.toolCallCount).toBe(3)
    expect(resumed?.usage).toEqual({ inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 })
  })

  it.each([
    ["a persisted call after the wait", (events: Array<Record<string, unknown>>) => events.map(event =>
      event.id === "prior-finished" ? { ...event, sequence: "6" } : event.id === "step-completed" ? { ...event, sequence: "7" } : event)],
    ["a duplicate receipt sequence", (events: Array<Record<string, unknown>>) => events.map(event =>
      event.id === "prior-finished" ? { ...event, sequence: "5" } : event)],
    ["an invalid receipt sequence", (events: Array<Record<string, unknown>>) => events.map(event =>
      event.id === "prior-finished" ? { ...event, sequence: "invalid" } : event)],
  ])("rejects %s in historical accounting", (_name, reviseEvents) => {
    const value = twoCallArchivedState()
    expect(() => build({ items: value.items, events: reviseEvents(value.events), persistedToolCallCount: 2 }))
      .toThrow("archived_wait_accounting_invalid")
  })

  it("retains a legacy nullable-task wait only when root-owned receipts prove its closure", () => {
    const legacyStep = { ...archivedStep, taskId: null }
    const legacyItems = [call, result].map(item => ({ ...item, taskId: null }))
    const alreadyClosed = { ...recovered, stepStatus: "waiting_for_tool" as const, stepCompletionRecorded: true,
      usageDelta: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }
    const resumed = build({ steps: [legacyStep, { id: "step-2", ordinal: 5, status: "running", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }],
      items: legacyItems, recoveredWaitControl: alreadyClosed })
    expect(resumed?.toolCallCount).toBe(3)
    expect(resumed?.usage).toEqual({ inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 })
    const foreign = build({ steps: [{ ...legacyStep, taskId: "foreign-root" }], items: legacyItems, recoveredWaitControl: undefined })
    expect(foreign?.toolCallCount).toBe(1)
  })

  it("does not add a suffix twice when the recovered control already has its authoritative completion", () => {
    const alreadyCompleted = { ...recovered, stepStatus: "waiting_for_tool" as const, stepCompletionRecorded: true,
      usageDelta: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }
    const resumed = build({ recoveredWaitControl: alreadyCompleted })
    expect(resumed?.toolCallCount).toBe(3)
    expect(resumed?.usage).toEqual({ inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 })
  })

  it("rejects mismatched historical model and Step completion counts", () => {
    const mismatched = archivedEvents.map(event => event.type === "step.completed"
      ? { ...event, payload: { stepId: "step-1", status: "waiting_for_dependency", toolCallCount: 4, taskId: scope.rootTaskId } }
      : event)
    expect(() => build({ events: mismatched })).toThrow("archived_wait_accounting_invalid")
  })

  it("keeps ordinary legacy resume counts based on persisted calls", () => {
    const resumed = build({ steps: [{ id: "legacy", ordinal: 1, status: "completed", inputTokens: "4", outputTokens: "2", estimatedCostUsd: "0.5" }],
      items: [], events: [], persistedToolCallCount: 6, recoveredWaitControl: undefined })
    expect(resumed).toEqual({ nextOrdinal: 5, stepCount: 1, toolCallCount: 6, inputThroughSequence: 8n, consumedInputIds: ["input-1"],
      usage: { inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0.5 } })
  })
})
