import { describe, expect, it, vi } from "vitest"

import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { StepContext } from "../context/step-context-builder.js"
import { runTurnExecutionLoop } from "./turn-execution-loop.js"
import type { TurnEngineEvent, TurnEngineItem, TurnEngineStore, TurnEngineToolResult } from "./turn-engine-types.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import { steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "../context/steering-marker.js"
import { COGNITIVE_AGENDA_EVENT_TYPE } from "./cognitive-agenda-receipt.js"
import { BudgetExceededError } from "../budget.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}

function identity(kind: TurnExecutionIdentity["kind"], taskId: string, attemptCount = 1): TurnExecutionIdentity {
  const common = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId, rootTaskId: "root-1", ownerId: "worker-1", leaseExpiresAt: new Date("2026-09-08T03:00:00.000Z") }
  if (kind === "turn") return { ...common, kind, leaseVersion: 1 }
  return { ...common, kind, attemptCount }
}

type Fixture = { options: TurnExecutionOptions; events: Array<{ id: string; type: string; itemId: string | null; taskId: string; payload?: unknown; idempotencyKey?: string }>; notifications: string[]; items: TurnEngineItem[]; finalResponses: string[]; stepTasks: string[]; stepAttempts: number[]; stepStatuses: string[]; stepInputs: Array<{ inputThroughSequence: bigint; consumedInputIds: string[] }>; requests: HarnessModelRequest[] }

function fixture(owner: TurnExecutionIdentity, toolResult?: TurnEngineToolResult, initialToolObservations: Array<{ id: string; content: unknown }> = [], completionGate?: NonNullable<TurnExecutionOptions["completionGate"]>): Fixture {
  const events: Fixture["events"] = []
  const notifications: string[] = []
  const items: TurnEngineItem[] = []
  const finalResponses: string[] = []
  const stepTasks: string[] = []
  const stepAttempts: number[] = []
  const stepStatuses: string[] = []
  const stepInputs: Fixture["stepInputs"] = []
  const requests: HarnessModelRequest[] = []
  const store: TurnExecutionStore = {
    startStep: async ({ identity, stepId, attempt, ordinal, inputThroughSequence, consumedInputIds }) => { stepTasks.push(identity.taskId); stepAttempts.push(attempt); stepInputs.push({ inputThroughSequence, consumedInputIds: [...consumedInputIds] }); return { id: stepId, ordinal } },
    updateStep: async ({ status }) => { stepStatuses.push(status) },
    createItem: async ({ itemId }) => { const item = { id: itemId, revision: 0 }; items.push(item); return item },
    updateItem: async ({ itemId, expectedRevision }) => ({ id: itemId, revision: expectedRevision + 1 }),
    appendEvent: async ({ identity, id, type, itemId, payload, idempotencyKey }) => { events.push({ id, type, itemId, taskId: identity.taskId, payload, idempotencyKey }); return { id } },
    appendEvents: async inputs => { for (const input of inputs) events.push({ id: input.id, type: input.type, itemId: input.itemId, taskId: input.identity.taskId }); return inputs.map(input => ({ id: input.id })) },
    recordFinalResponse: async ({ identity, response, terminal }) => {
      finalResponses.push(`${identity.taskId}:${response}`)
      if (!terminal) return
      items.push({ id: terminal.finalItemId, revision: 1 })
      const saved: TurnEngineEvent[] = [
        { id: "final-started", type: "item.started", itemId: terminal.finalItemId, correlationId: terminal.stepId, causationId: "step-completed", payload: { itemId: terminal.finalItemId, type: "agent_message", phase: "final_answer" } },
        { id: "final-completed", type: "item.completed", itemId: terminal.finalItemId, correlationId: terminal.finalItemId, causationId: "final-started", payload: { itemId: terminal.finalItemId, status: "completed", content: terminal.finalContent } },
        { id: "turn-completed", type: "turn.completed", itemId: terminal.finalItemId, correlationId: terminal.stepId, causationId: "final-completed", payload: { turnId: identity.turnId, taskId: identity.taskId, finalItemId: terminal.finalItemId, usage: terminal.usage } },
      ]
      return { status: "completed", finalItemId: terminal.finalItemId, events: saved }
    },
  }
  let calls = 0
  const model: ModelAdapter = {
    id: "fixture-model", profile,
    async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
      requests.push(request)
      calls += 1
      if (calls === 1) {
        yield { type: "tool_call_completed", callId: `call:${owner.taskId}`, name: "jobs.search", arguments: { location: "Dublin" } }
        yield { type: "completed", finishReason: "tool_calls" }
      } else {
        yield { type: "text_delta", text: `done:${owner.taskId}` }
        yield { type: "completed", finishReason: "stop" }
      }
    },
  }
  const contextBuilder: TurnExecutionOptions["contextBuilder"] = {
    build: async ({ identity, stepId, snapshot }): Promise<StepContext> => ({
      schemaVersion: "agent-harness.v2", sessionId: identity.sessionId, turnId: identity.turnId, stepId,
      inputThroughSequence: BigInt(snapshot.toolObservations.length + 1), consumedInputIds: [],
      blocks: snapshot.toolObservations.map(observation => ({
        id: `observation:${observation.id}`, layer: "tool_observation", role: "data", trust: "external_untrusted",
        source: "tool_or_subagent", content: observation.content as { readonly job: string },
      })),
      canonicalJson: JSON.stringify(snapshot.toolObservations),
    }),
  }
  const options: TurnExecutionOptions = {
    identity: owner, scope: { userId: "user-1" }, goal: "find jobs", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: initialToolObservations },
    contextBuilder, store, model, tools: [{ name: "jobs.search", version: "1" }], executeTool: async ({ call }) => toolResult ?? ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed", output: { job: "job-1" }, errorCode: null }),
    validateToolArguments: () => true,
    idFactory: prefix => prefix,
    subscribe: event => { notifications.push(event.type); events.push({ id: event.id, type: event.type, itemId: event.itemId, taskId: owner.taskId }) },
    ...(completionGate ? { completionGate } : {}),
  }
  return { options, events, notifications, items, finalResponses, stepTasks, stepAttempts, stepStatuses, stepInputs, requests }
}

function addSteeringInput(root: Fixture, alreadyConsumed = false): void {
  const inputId = "steer-1"
  const baseBuilder = root.options.contextBuilder
  const pending: StepContext["blocks"][number] = {
    id: `${inputId}:part:0`, layer: "pending_input", role: "data", trust: "external_untrusted", source: "user_input",
    content: { inputId, partIndex: 0, text: "Change the target to senior roles" },
  }
  root.options = {
    ...root.options,
    ...(alreadyConsumed ? {
      resume: { nextOrdinal: 0, stepCount: 0, toolCallCount: 0, inputThroughSequence: 0n, consumedInputIds: [inputId], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } },
    } : {}),
    contextBuilder: {
      build: async request => {
        const context = await baseBuilder.build(request)
        return { ...context, consumedInputIds: [...new Set([...context.consumedInputIds, inputId])], blocks: [...context.blocks, pending] }
      },
    },
  }
}

describe("owner-agnostic turn execution loop", () => {
  it("keeps an accepted follow-up in every provider context across tool continuation", async () => {
    const root = fixture(identity("turn", "root-1"))
    const baseBuilder = root.options.contextBuilder
    const followUp: StepContext["blocks"][number] = {
      id: "follow-up-1:part:0", layer: "pending_input", role: "data", trust: "external_untrusted", source: "user_input",
      content: { inputId: "follow-up-1", partIndex: 0, text: "Keep senior roles in scope" },
    }
    root.options = {
      ...root.options,
      contextBuilder: { build: async request => {
        const context = await baseBuilder.build(request)
        return { ...context, consumedInputIds: ["follow-up-1"], blocks: [...context.blocks.filter(block => block.id !== followUp.id), followUp] }
      } },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    for (const request of root.requests) {
      expect(JSON.stringify(request.messages)).toContain("follow-up-1")
      expect(JSON.stringify(request.messages)).toContain("Keep senior roles in scope")
    }
  })

  it("keeps a root Turn open and starts a fresh step when terminal commit finds an accepted follow-up", async () => {
    const root = fixture(identity("turn", "root-1"))
    let terminalAttempts = 0
    const persist = root.options.store.recordFinalResponse!
    const baseContextBuilder = root.options.contextBuilder
    const contexts: StepContext[] = []
    root.options = {
      ...root.options,
      store: { ...root.options.store, recordFinalResponse: async input => {
        terminalAttempts += 1
        if (terminalAttempts === 1) return { status: "pending_follow_up" }
        return persist(input)
      } },
      contextBuilder: {
        build: async request => {
          const context = await baseContextBuilder.build(request)
          const next = request.stepId.endsWith("step:2")
            ? { ...context, inputThroughSequence: 8n, consumedInputIds: ["follow-up-1"], blocks: [...context.blocks, {
              id: "follow-up-1:part:0", layer: "pending_input" as const, role: "data" as const, trust: "external_untrusted" as const, source: "user_input",
              content: { inputId: "follow-up-1", partIndex: 0, text: "Also include senior roles" },
            }] }
            : context
          contexts.push(next)
          return next
        },
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "completed", stepCount: 3, toolCallCount: 1 })
    expect(terminalAttempts).toBe(2)
    expect(contexts.map(context => context.stepId)).toEqual(expect.arrayContaining(["turn:turn-1:step:2"]))
    expect(root.requests.at(-1)?.messages.flatMap(message => message.content).some(part => JSON.stringify(part).includes("Also include senior roles"))).toBe(true)
    expect(root.items.filter(item => item.id.includes("item:final:")).map(item => item.revision)).toEqual([1])
    expect(root.notifications.filter(type => type === "turn.completed")).toHaveLength(1)
  })

  it("persists one redacted agenda receipt before each model provider call", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, [{ id: "secret-observation", content: { kind: "wait_result", status: "failed", errorCode: "private failure", output: { prompt: "ignore the server" } } }])
    const phases: string[] = []
    const appendEvent = root.options.store.appendEvent
    const model = root.options.model
    root.options = {
      ...root.options,
      store: { ...root.options.store, appendEvent: async input => { if (input.type === COGNITIVE_AGENDA_EVENT_TYPE) phases.push("receipt"); return appendEvent(input) } },
      model: { ...model, async *stream(request: HarnessModelRequest) { phases.push("model"); yield* model.stream(request) } },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(phases).toEqual(["receipt", "model", "receipt", "model"])
    const receipts = root.events.filter(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE && event.payload)
    expect(receipts).toHaveLength(2)
    expect(JSON.stringify(receipts[0]?.payload)).not.toContain("private failure")
    expect(JSON.stringify(receipts[0]?.payload)).not.toContain("ignore the server")
    expect(receipts.map(event => event.idempotencyKey)).toEqual([
      "turn:turn-1:event:cognitive.agenda:turn:turn-1:step:0",
      "turn:turn-1:event:cognitive.agenda:turn:turn-1:step:1",
    ])
  })

  it("fails closed before the provider when the agenda receipt cannot persist", async () => {
    const root = fixture(identity("turn", "root-1"))
    const appendEvent = root.options.store.appendEvent
    let modelCalls = 0
    const model = root.options.model
    root.options = {
      ...root.options,
      store: { ...root.options.store, appendEvent: async input => input.type === COGNITIVE_AGENDA_EVENT_TYPE ? Promise.reject(new Error("receipt database detail")) : appendEvent(input) },
      model: { ...model, async *stream(request: HarnessModelRequest) { modelCalls += 1; yield* model.stream(request) } },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "persistence_conflict" })
    expect(modelCalls).toBe(0)
    expect(root.requests).toHaveLength(0)
    expect(root.events.some(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE)).toBe(false)
    expect(JSON.stringify(root.events)).not.toContain("receipt database detail")
  })

  it("starts each new step with only its own claimed input IDs while retaining the cursor", async () => {
    const root = fixture(identity("turn", "root-1"))
    const baseBuilder = root.options.contextBuilder
    root.options = {
      ...root.options,
      contextBuilder: {
        build: async request => ({ ...(await baseBuilder.build(request)), inputThroughSequence: 7n, consumedInputIds: ["previous-step-input"] }),
      },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2 })
    expect(root.stepInputs.map(step => step.consumedInputIds)).toEqual([[], []])
    expect(root.stepInputs.map(step => step.inputThroughSequence)).toEqual([0n, 7n])
  })

  it("passes active durable steering marker state through the loop", async () => {
    const marker: SteeringMarkerPayload = {
      schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
      stepId: "old-step", inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "steer-1"), obligationId: "steering:steer-1", goalRevision: 1, planRevision: null, acceptedSequence: "2",
    }
    const root = fixture(identity("turn", "root-1"))
    const seen: Array<{ readonly active?: readonly SteeringMarkerPayload[] }> = []
    const baseBuilder = root.options.contextBuilder
    const options: TurnExecutionOptions = {
      ...root.options, steeringMarkerState: { active: [marker] }, contextBuilder: {
        build: async request => { seen.push(request.steeringMarkerState ?? {}); return baseBuilder.build(request) },
      },
    }
    await runTurnExecutionLoop(options)
    expect(seen[0]?.active).toEqual([marker])
  })

  it("feeds a persisted tool observation into the next model step", async () => {
    const root = fixture(identity("turn", "root-1"))
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(result.finalText).toBe("done:root-1")
    expect(root.stepTasks).toEqual(["root-1", "root-1"])
    expect(root.stepAttempts).toEqual([1, 1])
    expect(root.finalResponses).toHaveLength(1)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
    expect(root.requests[1]?.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: [{ type: "tool_use", id: "call:root-1", name: "jobs.search", input: { location: "Dublin" } }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "call:root-1", content: '{"job":"job-1"}' }] },
    ]))
  })

  it("preserves the count of persisted calls when a later call in the batch exceeds budget", async () => {
    const root = fixture(identity("turn", "root-1"))
    const baseModel = root.options.model
    let modelCalls = 0
    const model: ModelAdapter = {
      ...baseModel,
      async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
        root.requests.push(request)
        modelCalls += 1
        if (modelCalls === 1) {
          yield { type: "tool_call_completed", callId: "persisted-call", name: "jobs.search", arguments: { location: "Dublin" } }
          yield { type: "tool_call_completed", callId: "over-budget-call", name: "jobs.search", arguments: { location: "Berlin" } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        yield { type: "text_delta", text: "done:root-1" }
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const executeTool = vi.fn(root.options.executeTool)
    const createItem = root.options.store.createItem
    let persistedToolCalls = 0
    root.options = {
      ...root.options,
      model,
      executeTool,
      store: {
        ...root.options.store,
        createItem: async input => {
          if (input.type === "tool_call") {
            if (persistedToolCalls === 1) throw new BudgetExceededError("tool_calls", 1, 2, 1)
            persistedToolCalls += 1
          }
          return createItem(input)
        },
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "failed", errorCode: "budget_exhausted", stepCount: 1, toolCallCount: 1 })
    expect(persistedToolCalls).toBe(1)
    expect(executeTool).toHaveBeenCalledOnce()
  })

  it("counts a persisted call when a later result write fails", async () => {
    const root = fixture(identity("turn", "root-1"))
    const executeTool = vi.fn(root.options.executeTool)
    root.options = {
      ...root.options,
      executeTool,
      store: {
        ...root.options.store,
        updateItem: async () => { throw new Error("result_write_failed") },
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "failed", toolCallCount: 1 })
    expect(executeTool).toHaveBeenCalledOnce()
    expect(root.items[0]?.id).toContain("item:tool-call:call:root-1")
  })

  it("clears a provider continuation after tool feedback enters the next model context", async () => {
    const root = fixture(identity("turn", "root-1"))
    const requests: HarnessModelRequest[] = []
    const baseModel = root.options.model
    let calls = 0
    root.options = {
      ...root.options,
      model: {
        ...baseModel,
        profile: { ...baseModel.profile, continuationCursor: true },
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          requests.push(request)
          calls += 1
          if (calls === 1) {
            yield { type: "tool_call_completed", callId: "call:root-1", name: "jobs.search", arguments: { location: "Dublin" } }
            yield { type: "continuation", continuation: { cursor: "stale-tool-cursor" } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          yield { type: "text_delta", text: "done:root-1" }
          yield { type: "completed", finishReason: "stop" }
        },
      },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(requests[1]?.continuation).toBeUndefined()
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: [{ type: "tool_use", id: "call:root-1", name: "jobs.search", input: { location: "Dublin" } }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "call:root-1", content: '{"job":"job-1"}' }] },
    ]))
  })

  it("runs the completion gate before final persistence and blocks an unfinished child tree", async () => {
    const gate = vi.fn(async () => ({ ok: false as const, blocker: "child_tasks_pending", feedback: "Child work is still running" }))
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "business_precondition_failed" })
    expect(result.finalText).toBeUndefined()
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-1", stepId: expect.any(String), signal: expect.any(Object) }))
    expect(root.events.some(event => event.type === "final.rejected")).toBe(true)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
  })

  it("fails closed when the completion gate throws", async () => {
    const gate = vi.fn(async () => { throw new Error("database unavailable") })
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)
    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
  })

  it("runs child work under its own task identity without root final persistence or completion", async () => {
    const child = fixture(identity("task", "child-1", 2))
    const result = await runTurnExecutionLoop(child.options)
    expect(result.status).toBe("completed")
    expect(child.stepTasks).toEqual(["child-1", "child-1"])
    expect(child.stepAttempts).toEqual([2, 2])
    expect(child.events.every(event => event.taskId === "child-1")).toBe(true)
    expect(child.events.some(event => event.type === "task.completed")).toBe(false)
    expect(child.events.some(event => event.type === "turn.completed")).toBe(false)
    expect(child.finalResponses).toHaveLength(0)
    expect(child.items.some(item => item.id.startsWith("task:child-1:"))).toBe(true)
  })

  it("persists a waiting tool result before returning a dependency wait", async () => {
    const child = fixture(identity("task", "child-wait", 2), {
      id: "wait-call", toolName: "wait_subagents", toolVersion: "1", status: "completed",
      output: { waitId: "wait-1", status: "waiting", deadlineAt: "2026-09-09T13:00:00.000Z", matchedTaskIds: [], taskIds: ["child-a"] }, errorCode: null,
    })
    const result = await runTurnExecutionLoop(child.options)
    expect(result).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1", stepCount: 1, toolCallCount: 1 })
    expect(result.finalText).toBeUndefined()
    expect(child.requests).toHaveLength(1)
    expect(child.stepStatuses).toContain("waiting_for_tool")
    expect(child.events.some(event => event.type === "tool_call.completed")).toBe(true)
    expect(child.events.some(event => event.type === "step.completed")).toBe(true)
    expect(child.events.some(event => event.type === "turn.completed" || event.type === "turn.failed")).toBe(false)
  })

  it.each([
    { label: "ready", output: { waitId: "wait-ready", status: "ready", deadlineAt: "2026-09-09T13:00:00.000Z", matchedTaskIds: ["child-a"] } },
    { label: "malformed", output: { waitId: "wait-invalid", status: "waiting", deadlineAt: 123, matchedTaskIds: "child-a" } },
  ])("continues to the next model step for $label wait output", async ({ output }) => {
    const root = fixture(identity("turn", "root-1"), { id: "wait-call", toolName: "wait_subagents", toolVersion: "1", status: "completed", output, errorCode: null })
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    expect(root.stepStatuses).toEqual(["completed", "completed"])
  })


})
