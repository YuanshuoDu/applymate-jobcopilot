import { describe, expect, it, vi } from "vitest"
import type { TurnEngineResult, TurnEngineStep } from "./turn-engine-types.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { executeTools } from "./turn-execution-tools.js"
import { executeTurnToolStep } from "./turn-execution-tool-step.js"
import { persistRecoveredToolCall } from "./turn-execution-tool-recovery.js"
import { SessionPauseRequestedError } from "../session-gate.js"
import { DEPENDENCY_WAIT_BATCH_REJECTION, DEPENDENCY_WAIT_BATCH_REJECTION_MARKER } from "./dependency-wait-batch-rejection.js"

const identity = {
  kind: "task" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "task-1",
  rootTaskId: "root-1", ownerId: "worker-1", attemptCount: 2, leaseExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
}
const step: TurnEngineStep = { id: "step-1", ordinal: 1 }
const output: ModelStepResult = {
  text: "", reasoningSummary: "", toolCalls: [{ id: "tool-call-1", name: "wait_subagents", arguments: {} }],
  provider: "fixture", model: "fixture-model", finishReason: "tool_calls", usage: null, continuation: null,
}
const snapshot: TurnExecutionOptions["snapshot"] = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }
const rootIdentity: TurnExecutionIdentity = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 4, leaseExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
}
const rejectedWaitResult = DEPENDENCY_WAIT_BATCH_REJECTION
const rootWaitOutput = {
  waitId: "wait-12345678-1234-4234-9234-123456789012", status: "waiting", taskIds: ["subagent-00000000-0000-4000-8000-000000000001"],
  deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: ["subagent-00000000-0000-4000-8000-000000000001"],
  tasks: [{ taskId: "subagent-00000000-0000-4000-8000-000000000001", status: "waiting", role: "scout", result: null, failureReason: null }],
}

function persistedBatch(calls: ModelStepResult["toolCalls"], input: {
  identity?: TurnExecutionIdentity
  snapshot?: TurnExecutionOptions["snapshot"]
  seenCallIds?: Set<string>
  excludedToolCallIds?: Set<string>
  resultOutput?: unknown
  pauseOnToolCallStarted?: boolean
} = {}) {
  const owner = input.identity ?? rootIdentity
  const items: Array<{ itemId: string; type: string; status: string; content: unknown }> = []
  const events: Array<{ type: string; payload: unknown }> = []
  const stepUpdates: unknown[] = []
  const pause = input.pauseOnToolCallStarted ? new SessionPauseRequestedError() : null
  const executeTool = vi.fn(async (request: Parameters<TurnExecutionOptions["executeTool"]>[0]) => ({
    id: request.call.id, toolName: request.call.toolName, toolVersion: request.call.toolVersion,
    status: "completed" as const,
    output: input.resultOutput ?? { dispatched: request.call.toolName }, errorCode: null,
  }))
  const store = {
    createItem: async (request: { itemId: string; type: string; status: string; content: unknown }) => {
      items.push(request); return { id: request.itemId, revision: 0 }
    },
    updateItem: async (request: { itemId: string; expectedRevision: number; status: string; content: unknown }) => {
      items.push({ itemId: request.itemId, type: "updated", status: request.status, content: request.content })
      return { id: request.itemId, revision: request.expectedRevision + 1 }
    },
    appendEvent: async (request: { id: string; type: string; payload: unknown }) => {
      events.push(request)
      if (request.type === "tool_call.started" && pause) throw pause
      return { id: request.id }
    },
    updateStep: async (request: unknown) => { stepUpdates.push(request) },
  } as unknown as TurnExecutionStore
  const options = {
    identity: owner, scope: { userId: owner.userId }, goal: "Inspect current evidence",
    snapshot: input.snapshot ?? snapshot, store, executeTool, idFactory: (prefix: string) => prefix,
  } as unknown as TurnExecutionOptions
  const writer = new TurnExecutionEventWriter(options)
  const settled = vi.fn(), observedOutcomes: unknown[] = [], resetContinuation = vi.fn(), closedSteps = new Set<string>()
  const output: ModelStepResult = {
    text: "", reasoningSummary: "", toolCalls: calls, provider: "fixture", model: "fixture-model",
    finishReason: "tool_calls", usage: { inputTokens: 3, outputTokens: 2, estimatedCostUsd: 0.001 }, continuation: null,
  }
  const run = (signal = new AbortController().signal, executeOptions = options, seenCallIds = input.seenCallIds ?? new Set<string>()) =>
    executeTurnToolStep({
      options, executeOptions, writer, step, output, snapshot: options.snapshot, seenCallIds, signal,
      now: () => new Date("2026-10-01T00:00:00.000Z"), steeringMarkerState: undefined, questionIntentCallId: null, closedSteps,
      excludedToolCallIds: input.excludedToolCallIds ?? new Set<string>(), resetContinuation, onToolCallsSettled: settled,
      onOutcome: value => observedOutcomes.push(value),
    })
  return { run, options, writer, output, items, events, stepUpdates, executeTool, settled, observedOutcomes, resetContinuation, closedSteps, pause }
}

function setup(wait: TurnEngineResult | null, questionIntentCallId: string | null = null, suppliedRunTools?: typeof executeTools) {
  const updates: unknown[] = [], events: unknown[] = [], timeline: string[] = []
  const updateStep = vi.fn(async (value: unknown) => { updates.push(value); timeline.push("step-update") })
  const waitForUser = vi.fn(async () => { timeline.push("wait-for-user") })
  const append = vi.fn(async (...args: unknown[]) => { events.push(args); timeline.push("step-event"); return "event-1" })
  const options = { identity, store: { updateStep, waitForUser } } as unknown as TurnExecutionOptions
  const writer = { append } as unknown as TurnExecutionEventWriter
  const settled = vi.fn(), observedOutcomes: unknown[] = [], resetContinuation = vi.fn(), closedSteps = new Set<string>()
  const outcome = { wait, snapshot, steeringMarkerState: undefined, receipts: [] } as Awaited<ReturnType<typeof executeTools>>
  const runTools: typeof executeTools = suppliedRunTools ?? (async (...args) => {
    args[9]?.()
    return outcome
  })
  const run = (signal = new AbortController().signal) => executeTurnToolStep({
    options, executeOptions: options, writer, step, output, snapshot, seenCallIds: new Set(), signal,
    now: () => new Date("2026-10-01T00:00:00.000Z"), steeringMarkerState: undefined, questionIntentCallId, closedSteps,
    excludedToolCallIds: new Set(), resetContinuation, onToolCallsSettled: settled,
    onOutcome: value => observedOutcomes.push(value), runTools,
  })
  return { run, updates, events, timeline, updateStep, waitForUser, settled, observedOutcomes, resetContinuation, closedSteps }
}

describe("executeTurnToolStep", () => {
  it("accounts persisted calls and completes a normal tool step", async () => {
    const fixture = setup(null)
    await expect(fixture.run()).resolves.toEqual({ kind: "settled", wait: null })

    expect(fixture.settled).toHaveBeenCalledWith(1)
    expect(fixture.updateStep).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", stepId: step.id }))
    expect(fixture.events[0]).toEqual(expect.arrayContaining([
      "step.completed", step.id, null, expect.objectContaining({ status: "completed", toolCallCount: 1 }),
    ]))
    expect(fixture.resetContinuation).toHaveBeenCalledOnce()
    expect(fixture.closedSteps.has(step.id)).toBe(true)
  })

  it("persists dependency waits with the waiting-for-tool step status", async () => {
    const wait = { status: "waiting_for_dependency", waitId: "wait-1", stepCount: 0, toolCallCount: 0 } as const
    const fixture = setup(wait)
    await expect(fixture.run()).resolves.toEqual({ kind: "settled", wait })

    expect(fixture.updateStep).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting_for_tool" }))
    expect(fixture.events[0]).toEqual(expect.arrayContaining([
      "step.completed", step.id, null, expect.objectContaining({ status: "waiting_for_dependency" }),
    ]))
    expect(fixture.closedSteps.has(step.id)).toBe(true)
  })

  it("stores ordinary user waits after closing the step", async () => {
    const wait = { status: "waiting_for_user", waitId: "question-1", stepCount: 0, toolCallCount: 0 } as const
    const fixture = setup(wait)
    await fixture.run()

    expect(fixture.updateStep).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting_for_user" }))
    expect(fixture.timeline).toEqual(["step-update", "step-event", "wait-for-user"])
    expect(fixture.closedSteps.has(step.id)).toBe(true)
  })

  it("returns native question waits before ordinary step finalization", async () => {
    const wait = { status: "waiting_for_user", waitId: "question-1", stepCount: 0, toolCallCount: 0 } as const
    const fixture = setup(wait, "ask-call")
    await expect(fixture.run()).resolves.toMatchObject({ kind: "question_wait", wait })

    expect(fixture.settled).toHaveBeenCalledWith(1)
    expect(fixture.updateStep).not.toHaveBeenCalled()
    expect(fixture.events).toHaveLength(0)
    expect(fixture.waitForUser).not.toHaveBeenCalled()
    expect(fixture.resetContinuation).not.toHaveBeenCalled()
    expect(fixture.closedSteps.has(step.id)).toBe(true)
  })

  it("resets the model continuation before rejecting a lost execution", async () => {
    const fixture = setup(null)
    const controller = new AbortController()
    controller.abort(new Error("interrupted"))

    await expect(fixture.run(controller.signal)).rejects.toThrow("execution_lost")

    expect(fixture.resetContinuation).toHaveBeenCalledOnce()
    expect(fixture.updateStep).not.toHaveBeenCalled()
    expect(fixture.settled).toHaveBeenCalledWith(1)
  })

  it("settles tool-call accounting when execution throws", async () => {
    const error = new Error("fixture failure")
    const runTools: typeof executeTools = async () => { throw error }
    const fixture = setup(null, null, runTools)

    await expect(fixture.run()).rejects.toBe(error)

    expect(fixture.settled).toHaveBeenLastCalledWith(0)
    expect(fixture.resetContinuation).not.toHaveBeenCalled()
  })

  it.each([
    { label: "agent.wait first", calls: [{ id: "wait-first", name: "agent.wait", arguments: {} }, { id: "search-after", name: "jobs.search", arguments: {} }] },
    { label: "wait_subagents last", calls: [{ id: "search-before", name: "jobs.search", arguments: {} }, { id: "wait-last", name: "wait_subagents", arguments: {} }] },
    { label: "two wait tools", calls: [{ id: "wait-one", name: "agent.wait", arguments: {} }, { id: "wait-two", name: "wait_subagents", arguments: {} }] },
  ] as const)("rejects a fresh Root batch with $label before dispatch and pairs every call", async ({ calls }) => {
    const fixture = persistedBatch(calls)

    await expect(fixture.run()).resolves.toMatchObject({ kind: "settled", wait: null })

    expect(fixture.executeTool).not.toHaveBeenCalled()
    const callItems = fixture.items.filter(item => item.type === "tool_call")
    const resultItems = fixture.items.filter(item => item.type === "tool_result")
    expect(callItems).toHaveLength(calls.length)
    expect(resultItems).toHaveLength(calls.length)
    expect(callItems.map(item => (item.content as { toolCallId: string }).toolCallId)).toEqual(calls.map(call => call.id))
    expect(callItems.map(item => (item.content as { dependencyWaitBatchRejection?: string }).dependencyWaitBatchRejection))
      .toEqual(calls.map(() => DEPENDENCY_WAIT_BATCH_REJECTION_MARKER))
    expect(resultItems.map(item => (item.content as { toolCallId: string }).toolCallId)).toEqual(calls.map(call => call.id))
    const completedCalls = fixture.items.filter(item => item.type === "updated" && item.itemId.includes(":item:tool-call:"))
    expect(completedCalls.map(item => (item.content as { dependencyWaitBatchRejection?: string }).dependencyWaitBatchRejection))
      .toEqual(calls.map(() => DEPENDENCY_WAIT_BATCH_REJECTION_MARKER))
    expect(JSON.stringify(fixture.events)).not.toContain(DEPENDENCY_WAIT_BATCH_REJECTION_MARKER)
    expect(resultItems.map(item => (item.content as { output: unknown }).output)).toEqual(calls.map(() => rejectedWaitResult))
    expect(resultItems.map(item => (item.content as { errorCode: string }).errorCode)).toEqual(calls.map(() => rejectedWaitResult.code))
    expect(fixture.events.filter(event => event.type.endsWith("tool_call.failed")).map(event => (event.payload as { errorCode: string }).errorCode))
      .toEqual(calls.map(() => rejectedWaitResult.code))
    expect(fixture.stepUpdates).toContainEqual(expect.objectContaining({ status: "completed", stepId: step.id }))
    expect(fixture.settled).toHaveBeenCalledWith(calls.length)
    expect(fixture.resetContinuation).toHaveBeenCalledOnce()
    expect(fixture.observedOutcomes[0]).toMatchObject({ wait: null })
  })

  it("keeps the rejection marker and exact call input in the private interrupted row when a pause denies the start event", async () => {
    const calls = [
      { id: "paused-wait", name: "agent.wait", arguments: { taskIds: ["task-a"], mode: "all" } },
      { id: "paused-search", name: "jobs.search", arguments: { query: "engineer" } },
    ]
    const fixture = persistedBatch(calls, { pauseOnToolCallStarted: true })

    await expect(fixture.run()).rejects.toBe(fixture.pause)

    const privateCall = fixture.items.find(item => item.type === "tool_call")
    expect(privateCall?.content).toMatchObject({
      toolCallId: calls[0]!.id, input: calls[0]!.arguments,
      dependencyWaitBatchRejection: DEPENDENCY_WAIT_BATCH_REJECTION_MARKER,
    })
    const interruptedCall = fixture.items.find(item => item.type === "updated" && item.itemId.includes(":item:tool-call:"))
    expect(interruptedCall?.content).toMatchObject({
      toolCallId: calls[0]!.id, input: calls[0]!.arguments, status: "interrupted", errorCode: "session_pause_requested",
      dependencyWaitBatchRejection: DEPENDENCY_WAIT_BATCH_REJECTION_MARKER,
    })
    expect(fixture.executeTool).not.toHaveBeenCalled()
    expect(JSON.stringify(fixture.events)).not.toContain(DEPENDENCY_WAIT_BATCH_REJECTION_MARKER)
  })

  it("keeps an ordinary interrupted private tool call in its existing shape", async () => {
    const fixture = persistedBatch([{ id: "ordinary-paused-search", name: "jobs.search", arguments: { query: "engineer" } }], {
      pauseOnToolCallStarted: true,
    })

    await expect(fixture.run()).rejects.toBe(fixture.pause)

    const interruptedCall = fixture.items.find(item => item.type === "updated" && item.itemId.includes(":item:tool-call:"))
    expect(interruptedCall?.content).toEqual({
      toolCallId: "ordinary-paused-search", toolName: "jobs.search", status: "interrupted", errorCode: "session_pause_requested",
    })
    expect(JSON.stringify(fixture.events)).not.toContain(DEPENDENCY_WAIT_BATCH_REJECTION_MARKER)
  })

  it("retains the marker only for an exact Root durable result during a second recovery write", async () => {
    const call = { id: "recovered-wait", name: "agent.wait", arguments: { taskIds: ["task-a"] } }
    const durableResult = {
      id: call.id, toolName: call.name, toolVersion: "1", status: "failed" as const,
      errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code, output: DEPENDENCY_WAIT_BATCH_REJECTION,
    }
    const recovery = {
      action: "reconcile" as const, stepId: step.id, toolVersion: "1", call,
      callItem: { id: "recovered-call-item", revision: 2 }, durableResult,
    }
    const fixture = persistedBatch([])

    await persistRecoveredToolCall(fixture.options, fixture.writer, recovery, durableResult, () => new Date("2026-10-01T00:00:00.000Z"))

    const recoveredPrivateCall = fixture.items.find(item => item.type === "updated" && item.itemId === recovery.callItem.id)
    expect(recoveredPrivateCall?.content).toMatchObject({
      toolCallId: call.id, input: call.arguments, status: "failed", errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code,
      dependencyWaitBatchRejection: DEPENDENCY_WAIT_BATCH_REJECTION_MARKER,
    })
    expect(JSON.stringify(fixture.events)).not.toContain(DEPENDENCY_WAIT_BATCH_REJECTION_MARKER)

    const replay = persistedBatch([])
    const replayRecovery = { action: "replay" as const, stepId: step.id, toolVersion: "1", call,
      callItem: { id: "replayed-call-item", revision: 0 } }
    await persistRecoveredToolCall(replay.options, replay.writer, replayRecovery, durableResult, () => new Date())
    expect(replay.items.find(item => item.itemId === replayRecovery.callItem.id)?.content)
      .not.toHaveProperty("dependencyWaitBatchRejection")

    const child = persistedBatch([], { identity })
    await persistRecoveredToolCall(child.options, child.writer, recovery, durableResult, () => new Date())
    expect(child.items.find(item => item.itemId === recovery.callItem.id)?.content)
      .not.toHaveProperty("dependencyWaitBatchRejection")
  })

  it("preserves an ordinary Root multi-tool batch", async () => {
    const calls = [
      { id: "search-one", name: "jobs.search", arguments: {} },
      { id: "search-two", name: "jobs.search", arguments: { page: 2 } },
    ]
    const fixture = persistedBatch(calls)

    await expect(fixture.run()).resolves.toMatchObject({ kind: "settled", wait: null })

    expect(fixture.executeTool).toHaveBeenCalledTimes(2)
    expect(fixture.items.filter(item => item.type === "tool_result").map(item => (item.content as { errorCode: unknown }).errorCode))
      .toEqual([null, null])
  })

  it("preserves a single Root dependency wait", async () => {
    const fixture = persistedBatch([{ id: "solo-wait", name: "agent.wait", arguments: {} }], { resultOutput: rootWaitOutput })

    await expect(fixture.run()).resolves.toMatchObject({ kind: "settled", wait: { status: "waiting_for_dependency", waitId: rootWaitOutput.waitId } })

    expect(fixture.executeTool).toHaveBeenCalledOnce()
    expect(fixture.stepUpdates).toContainEqual(expect.objectContaining({ status: "waiting_for_tool", stepId: step.id }))
  })

  it.each([
    { label: "repeated within the response", calls: [{ id: "same-call", name: "agent.wait", arguments: {} }, { id: "same-call", name: "jobs.search", arguments: {} }] },
    { label: "already seen", calls: [{ id: "seen-call", name: "agent.wait", arguments: {} }, { id: "new-call", name: "jobs.search", arguments: {} }], seen: new Set(["seen-call"]) },
    { label: "already observed", calls: [{ id: "observed-call", name: "agent.wait", arguments: {} }, { id: "new-call", name: "jobs.search", arguments: {} }], observed: [{ id: "old-result", content: { toolCallId: "observed-call", toolName: "agent.wait", status: "failed" } }] },
    { label: "excluded by child replay", calls: [{ id: "excluded-call", name: "agent.wait", arguments: {} }, { id: "new-call", name: "jobs.search", arguments: {} }], excluded: new Set(["excluded-call"]) },
  ] as const)("fails closed when mixed-batch IDs are $label", async ({ calls, seen, observed, excluded }) => {
    const fixture = persistedBatch(calls, {
      ...(seen ? { seenCallIds: new Set(seen) } : {}),
      ...(observed ? { snapshot: { ...snapshot, toolObservations: [...observed] } } : {}),
      ...(excluded ? { excludedToolCallIds: new Set(excluded) } : {}),
    })

    await expect(fixture.run()).rejects.toMatchObject({ code: "invalid_output" })

    expect(fixture.executeTool).not.toHaveBeenCalled()
    expect(fixture.items).toHaveLength(0)
    expect(fixture.events).toHaveLength(0)
    expect(fixture.settled).toHaveBeenCalledWith(0)
  })

  it("rejects a mixed ask_user batch before creating receipts", async () => {
    const fixture = persistedBatch([
      { id: "wait-call", name: "agent.wait", arguments: {} },
      { id: "ask-call", name: "agent.ask_user", arguments: { question: "Which city?" } },
    ])

    await expect(fixture.run()).rejects.toMatchObject({ code: "invalid_output" })

    expect(fixture.executeTool).not.toHaveBeenCalled()
    expect(fixture.items).toHaveLength(0)
    expect(fixture.events).toHaveLength(0)
    expect(fixture.settled).toHaveBeenCalledWith(0)
  })

  it("fails closed when the tool executor carries a different Root identity", async () => {
    const fixture = persistedBatch([
      { id: "wait-call", name: "agent.wait", arguments: {} },
      { id: "search-call", name: "jobs.search", arguments: {} },
    ])
    const otherOwner = { ...rootIdentity, leaseVersion: rootIdentity.leaseVersion + 1 }

    await expect(fixture.run(undefined, { ...fixture.options, identity: otherOwner })).rejects.toMatchObject({ code: "persistence_conflict" })

    expect(fixture.executeTool).not.toHaveBeenCalled()
    expect(fixture.items).toHaveLength(0)
  })
})
