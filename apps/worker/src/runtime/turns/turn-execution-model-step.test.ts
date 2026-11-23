import { describe, expect, it, vi } from "vitest"
import { Type } from "@sinclair/typebox"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import type { BudgetReservation } from "../budget.js"

import { runTurnExecutionModelStep } from "./turn-execution-model-step.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"

describe("admitted Root model step projection", () => {
  it("records completed usage once and exposes only a safe plan-rejection result", async () => {
    const secret = "malformed-plan-argument-secret"
    const usage = { inputTokens: 23, outputTokens: 13, estimatedCostUsd: 0.031 }
    const events: Array<{ type: string; payload: unknown }> = []
    const timeline: string[] = []
    const append = vi.fn(async (type: string, _correlationId: string, _itemId: string | null, payload: unknown) => {
      events.push({ type, payload }); timeline.push(type); return `${type}-event`
    })
    const updateStep = vi.fn(async input => { timeline.push(`step:${input.status}`) })
    const settle = vi.fn(() => { timeline.push("budget:settle") })
    const model: ModelAdapter = {
      id: "fixture", profile: { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true,
        streaming: true, continuationCursor: true, supportsParallelTools: true, supportsStreamingToolArgs: true,
        supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
        supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "unknown" },
      async *stream() {
        yield { type: "tool_call_completed", callId: "call-plan", name: "agent.plan", arguments: { secret } }
        yield { type: "usage", ...usage }
        yield { type: "continuation", continuation: { cursor: "drop-this-cursor" } }
        yield { type: "completed", finishReason: "tool_calls" }
      },
    }
    const request: HarnessModelRequest = { schemaVersion: "agent-harness.v2", provider: "fixture", model: "fixture-model",
      messages: [{ role: "user", content: [{ type: "text", text: "read current graph" }] }],
      tools: [{ name: "agent.plan", inputSchema: Type.Object({ valid: Type.Boolean() }, { additionalProperties: false }) }],
      capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: true },
      signal: new AbortController().signal, metadata: { sessionId: "s", turnId: "t", stepId: "step", taskId: "root", userId: "u", featureId: "agent-harness.turn", traceId: "t:step" } }
    const identity = { kind: "turn", taskId: "root", rootTaskId: "root" }
    const options = { identity, store: { updateStep }, model, validateToolArguments: () => "invalid" } as unknown as TurnExecutionOptions
    const output = await runTurnExecutionModelStep({ options, writer: { append }, stepId: "step", request,
      reservation: { settle } as unknown as BudgetReservation, classifyRootPlanSchemaRejection: true,
      now: new Date("2026-11-23T15:00:00Z"), onUsageAccepted: vi.fn(() => { timeline.push("usage:accepted") }) })

    expect(output).toMatchObject({ toolCalls: [], text: "", reasoningSummary: "", continuation: null, usage, planSchemaRejection: "invalid_arguments" })
    expect(settle).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledWith(usage)
    expect(events.map(event => event.type)).toEqual(["model.started", "model.completed", "model.usage"])
    expect(timeline).toEqual(["model.started", "step:streaming", "model.completed", "budget:settle", "usage:accepted", "model.usage"])
    expect(updateStep).toHaveBeenCalledWith({ identity, stepId: "step", status: "streaming", finishReason: "tool_calls", errorCode: null,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd, now: new Date("2026-11-23T15:00:00Z") })
    expect(events[1]?.payload).toMatchObject({ toolCallCount: 0 })
    expect(events[2]?.payload).toMatchObject({ usage })
    expect(JSON.stringify({ output, events })).not.toContain(secret)
    expect(JSON.stringify({ output, events })).not.toContain("drop-this-cursor")
  })

  it("keeps the accounting checkpoint open when durable usage publication fails", async () => {
    const usage = { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.004 }
    const updateStep = vi.fn(async () => undefined)
    const persistedEvents: string[] = []
    const append = vi.fn(async (type: string) => {
      if (type === "model.usage") throw new Error("usage write failed")
      persistedEvents.push(type)
      return `${type}-event`
    })
    const model: ModelAdapter = {
      id: "fixture", profile: { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true,
        streaming: true, continuationCursor: true, supportsParallelTools: true, supportsStreamingToolArgs: true,
        supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
        supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "unknown" },
      async *stream() {
        yield { type: "tool_call_completed", callId: "call-plan", name: "agent.plan", arguments: { malformed: true } }
        yield { type: "usage", ...usage }
        yield { type: "completed", finishReason: "tool_calls" }
      },
    }
    const identity = { kind: "turn", taskId: "root", rootTaskId: "root" }
    const options = { identity, store: { updateStep }, model, validateToolArguments: () => "invalid" } as unknown as TurnExecutionOptions
    await expect(runTurnExecutionModelStep({ options, writer: { append }, stepId: "step", request: {
      schemaVersion: "agent-harness.v2", provider: "fixture", model: "fixture-model", messages: [],
      tools: [{ name: "agent.plan", inputSchema: Type.Object({ valid: Type.Boolean() }, { additionalProperties: false }) }],
      capabilities: { nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: true },
      signal: new AbortController().signal, metadata: { sessionId: "s", turnId: "t", stepId: "step", taskId: "root", userId: "u", featureId: "agent-harness.turn", traceId: "t:step" },
    }, reservation: { settle: vi.fn() } as unknown as BudgetReservation, classifyRootPlanSchemaRejection: true,
    now: new Date("2026-11-23T15:00:00Z"), onUsageAccepted: vi.fn() })).rejects.toThrow("usage write failed")

    expect(updateStep).toHaveBeenCalledTimes(1)
    expect(updateStep).toHaveBeenCalledWith(expect.objectContaining({ status: "streaming", finishReason: "tool_calls", errorCode: null,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd }))
    expect(append.mock.calls.map(([type]) => type)).toEqual(["model.started", "model.completed", "model.usage"])
    expect(persistedEvents).toEqual(["model.started", "model.completed"])
  })
})
