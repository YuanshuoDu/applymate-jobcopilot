import { describe, expect, it, vi } from "vitest"
import type { TurnEngineResult, TurnEngineStep } from "./turn-engine-types.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { executeTools } from "./turn-execution-tools.js"
import { executeTurnToolStep } from "./turn-execution-tool-step.js"

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
})