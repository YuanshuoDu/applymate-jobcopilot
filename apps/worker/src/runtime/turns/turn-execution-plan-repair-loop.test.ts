import { describe, expect, it } from "vitest"
import { Type } from "@sinclair/typebox"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"

import { runTurnExecutionLoop } from "./turn-execution-loop.js"
import type { TurnEngineStore, TurnEngineToolResult } from "./turn-engine-types.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import { PLAN_SCHEMA_REPAIR_ERROR_CODE, PLAN_SCHEMA_REPAIR_INSTRUCTION } from "./turn-execution-plan-repair.js"

const invalidSecret = "raw-invalid-agent-plan-arguments-must-not-escape"
const usage = { inputTokens: 29, outputTokens: 12, estimatedCostUsd: 0.041 }
const profile = { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: true,
  supportsParallelTools: true, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: true,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const }

function rootIdentity(): TurnExecutionIdentity {
  return { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
    ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-11-23T16:00:00Z") }
}

function childIdentity(): TurnExecutionIdentity {
  return { kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1", rootTaskId: "root-1",
    ownerId: "worker-1", attemptCount: 1, leaseExpiresAt: new Date("2026-11-23T16:00:00Z") }
}

function response(kind: "invalid" | "valid" | "transport", request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
  return (async function* () {
    if (kind === "transport") throw new Error("fixture transport boundary")
    if (kind === "invalid") {
      yield { type: "text_delta", text: invalidSecret }
      yield { type: "reasoning_summary_delta", text: invalidSecret }
      yield { type: "tool_call_completed", callId: "invalid-" + request.metadata.stepId, name: "agent.plan", arguments: { invalidSecret } }
      yield { type: "usage", ...usage }
      yield { type: "continuation", continuation: { cursor: "invalid-provider-cursor" } }
      yield { type: "completed", finishReason: "tool_calls" }
      return
    }
    yield { type: "tool_call_completed", callId: "valid-" + request.metadata.stepId, name: "agent.plan", arguments: { valid: true } }
    yield { type: "usage", inputTokens: 31, outputTokens: 14, estimatedCostUsd: 0.047 }
    yield { type: "completed", finishReason: "tool_calls" }
  })()
}

function fixture(responses: readonly ("invalid" | "valid" | "transport")[], identity = rootIdentity()) {
  const events: Array<Record<string, unknown>> = [], stepUpdates: Array<Record<string, unknown>> = [], requests: HarnessModelRequest[] = [], dispatched: unknown[] = []
  const timeline: Array<{ kind: "event" | "step"; type?: string; correlationId?: string; input?: Record<string, unknown> }> = []
  let itemRevision = 0, modelCalls = 0
  const store: TurnEngineStore = {
    startStep: async input => ({ id: input.stepId, ordinal: input.ordinal }),
    updateStep: async input => { stepUpdates.push({ ...input }); timeline.push({ kind: "step", input: { ...input } }) },
    createItem: async input => ({ id: input.itemId, revision: ++itemRevision }),
    updateItem: async input => ({ id: input.itemId, revision: input.expectedRevision + 1 }),
    appendEvent: async input => { events.push({ ...input }); timeline.push({ kind: "event", type: input.type, correlationId: input.correlationId }); return { id: input.id } },
    appendEvents: async inputs => { for (const input of inputs) { events.push({ ...input }); timeline.push({ kind: "event", type: input.type, correlationId: input.correlationId }) } return inputs.map(input => ({ id: input.id })) },
    recordFinalResponse: async () => undefined,
  }
  const model: ModelAdapter = { id: "plan-repair-fixture", profile, async *stream(request) {
    requests.push(request)
    const next = responses[modelCalls++]
    if (!next) throw new Error("unexpected extra model request")
    yield* response(next, request)
  } }
  const contextBuilder: TurnExecutionOptions["contextBuilder"] = { build: async input => ({ schemaVersion: "agent-harness.v2",
    sessionId: input.identity.sessionId, turnId: input.identity.turnId, stepId: input.stepId, inputThroughSequence: 0n,
    consumedInputIds: [], blocks: input.snapshot.system.map(seed => ({ id: "system:" + seed.id, layer: "system" as const,
      role: "instruction" as const, trust: "system" as const, source: "harness", content: String(seed.content) })), canonicalJson: "{}" }) }
  const options: TurnExecutionOptions = { identity, scope: { userId: "user-1" }, goal: "Build a plan", snapshot: {
    system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }, contextBuilder, store: store as unknown as TurnExecutionStore,
    model, tools: [{ name: "agent.plan", version: "1", inputSchema: Type.Object({ valid: Type.Boolean() }, { additionalProperties: false }) }], validateToolArguments: (_name, value) => {
      const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
      return record?.valid === true ? true : "private schema details"
    }, executeTool: async ({ call }): Promise<TurnEngineToolResult> => {
      dispatched.push({ name: call.toolName, arguments: call.input })
      return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed", output: { accepted: true }, errorCode: null }
    }, idFactory: prefix => prefix, maxSteps: 4, now: () => new Date("2026-11-23T15:00:00Z") }
  return { options, events, stepUpdates, requests, dispatched, timeline, run: () => runTurnExecutionLoop(options) }
}

function eventPayload(events: readonly Record<string, unknown>[], type: string): Record<string, unknown>[] {
  return events.filter(event => event.type === type).map(event => event.payload as Record<string, unknown>)
}

describe("Root plan schema repair loop", () => {
  it("settles a completed invalid proposal, then dispatches only the corrected proposal", async () => {
    const test = fixture(["invalid", "valid", "transport"])
    const result = await test.run()

    expect(result.status).toBe("failed")
    expect(test.requests).toHaveLength(3)
    expect(test.requests[1]?.messages.some(message => message.role === "system"
      && message.content.some(part => part.type === "text" && part.text.includes(PLAN_SCHEMA_REPAIR_INSTRUCTION)))).toBe(true)
    expect(test.requests[1]?.continuation).toBeUndefined()
    expect(test.dispatched).toEqual([{ name: "agent.plan", arguments: { valid: true } }])
    expect(eventPayload(test.events, "model.completed").map(payload => payload.toolCallCount)).toEqual([0, 1])
    expect(eventPayload(test.events, "model.usage").map(payload => payload.usage)).toEqual([usage, { inputTokens: 31, outputTokens: 14, estimatedCostUsd: 0.047 }])
    const rejectedStepId = String(test.stepUpdates[0]?.stepId)
    expect(eventPayload(test.events, "step.completed")[0]).toEqual({ stepId: rejectedStepId, status: "completed", errorCode: PLAN_SCHEMA_REPAIR_ERROR_CODE, taskId: "root-1" })
    expect(test.stepUpdates[0]).toMatchObject({ status: "streaming", finishReason: "tool_calls", errorCode: null,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd })
    expect(test.stepUpdates[1]).toMatchObject({ status: "completed", finishReason: "tool_calls", errorCode: PLAN_SCHEMA_REPAIR_ERROR_CODE,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd })
    const checkpointIndex = test.timeline.findIndex(entry => entry.kind === "step" && entry.input?.stepId === rejectedStepId && entry.input.status === "streaming")
    const usageIndex = test.timeline.findIndex(entry => entry.kind === "event" && entry.type === "model.usage" && entry.correlationId === rejectedStepId)
    const completedEventIndex = test.timeline.findIndex(entry => entry.kind === "event" && entry.type === "step.completed" && entry.correlationId === rejectedStepId)
    const nextModelStartIndex = test.timeline.findIndex((entry, index) => index > completedEventIndex && entry.kind === "event" && entry.type === "model.started")
    expect(checkpointIndex).toBeGreaterThanOrEqual(0)
    expect(checkpointIndex).toBeLessThan(usageIndex)
    expect(usageIndex).toBeLessThan(completedEventIndex)
    expect(completedEventIndex).toBeLessThan(nextModelStartIndex)
    expect(test.timeline.slice(checkpointIndex + 1, completedEventIndex).some(entry => entry.kind === "event" && entry.type === "model.started")).toBe(false)
    expect(JSON.stringify({ events: test.events, requests: test.requests, dispatched: test.dispatched })).not.toContain(invalidSecret)
    expect(JSON.stringify(test.events)).not.toContain("invalid-provider-cursor")
  })

  it("settles a second invalid Root plan proposal and fails without another repair Step", async () => {
    const test = fixture(["invalid", "invalid"])
    const result = await test.run()

    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(test.requests).toHaveLength(2)
    expect(test.dispatched).toEqual([])
    expect(eventPayload(test.events, "model.completed").map(payload => payload.toolCallCount)).toEqual([0, 0])
    expect(eventPayload(test.events, "model.usage").map(payload => payload.usage)).toEqual([usage, usage])
    expect(eventPayload(test.events, "step.completed").filter(payload => payload.errorCode === PLAN_SCHEMA_REPAIR_ERROR_CODE)).toHaveLength(1)
    expect(test.stepUpdates.map(row => row.status)).toEqual(["streaming", "completed", "streaming", "failed"])
    expect(test.stepUpdates[2]).toMatchObject({ status: "streaming", errorCode: null, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd })
    expect(test.stepUpdates[3]).toMatchObject({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd })
    expect(JSON.stringify({ events: test.events, requests: test.requests })).not.toContain(invalidSecret)
  })

  it("keeps invalid child plan output on the existing fail-closed path", async () => {
    const test = fixture(["invalid", "valid"], childIdentity())
    const result = await test.run()

    expect(result.status).toBe("failed")
    expect(test.requests).toHaveLength(1)
    expect(test.dispatched).toEqual([])
    expect(eventPayload(test.events, "step.completed").some(payload => payload.errorCode === PLAN_SCHEMA_REPAIR_ERROR_CODE)).toBe(false)
    expect(JSON.stringify(test.requests[0]?.messages)).not.toContain(PLAN_SCHEMA_REPAIR_INSTRUCTION)
  })
})
