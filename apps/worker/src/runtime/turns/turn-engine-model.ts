import {
  completeStructuredStep,
  type HarnessModelRequest,
  type ModelAdapter,
  type ModelResponse,
  type ModelStreamEvent,
} from "@jobcopilot/agent-model"

import type { TurnEngineToolCall } from "./turn-engine-types.js"
import { TurnEngineError } from "./turn-engine-types.js"

export type ModelStepResult = {
  readonly text: string
  readonly reasoningSummary: string
  readonly toolCalls: readonly TurnEngineToolCall[]
  readonly finishReason: ModelResponse["finishReason"]
  readonly usage: ModelResponse["usage"]
  readonly continuation: ModelResponse["continuationCursor"]
}

export async function runModelStep(
  adapter: ModelAdapter,
  request: HarnessModelRequest,
  validateToolArguments?: (toolName: string, input: unknown) => boolean | string,
): Promise<ModelStepResult> {
  if (!adapter.profile.nativeTools) return runStructuredStep(adapter, request, validateToolArguments)

  let text = ""
  let reasoningSummary = ""
  let finishReason: ModelResponse["finishReason"] | undefined
  let usage: ModelResponse["usage"] = null
  let continuation: ModelResponse["continuationCursor"] = null
  const calls = new Map<string, TurnEngineToolCall>()
  for await (const event of adapter.stream(request)) consume(event, calls, (value) => { text += value }, (value) => { reasoningSummary += value }, (value) => { finishReason = value }, (value) => { usage = value }, (value) => { continuation = value })
  if (!finishReason) throw new Error("Model stream completed without a finish reason")
  return { text, reasoningSummary, toolCalls: [...calls.values()], finishReason, usage, continuation }
}

async function runStructuredStep(
  adapter: ModelAdapter,
  request: HarnessModelRequest,
  validateToolArguments?: (toolName: string, input: unknown) => boolean | string,
): Promise<ModelStepResult> {
  const result = await completeStructuredStep(adapter, request, {
    validateToolArguments: (call) => validateToolArguments?.(call.tool, call.arguments) ?? "A tool arguments validator is required before execution",
  })
  if (result.step.kind === "call_tool") {
    return {
      text: "",
      reasoningSummary: result.step.rationaleSummary,
      toolCalls: [{ id: result.step.callId, name: result.step.tool, arguments: result.step.arguments }],
      finishReason: "tool_calls",
      usage: result.response.usage,
      continuation: result.response.continuationCursor,
    }
  }
  if (result.step.kind !== "finish") throw new TurnEngineError("invalid_output", `Structured model output requested unsupported action: ${result.step.kind}`)
  const response = result.step.response
  const text = typeof response.text === "string" ? response.text : JSON.stringify(response)
  return { text: text ?? "", reasoningSummary: "", toolCalls: [], finishReason: "stop", usage: result.response.usage, continuation: result.response.continuationCursor }
}

function consume(
  event: ModelStreamEvent,
  calls: Map<string, TurnEngineToolCall>,
  addText: (value: string) => void,
  addReasoning: (value: string) => void,
  setFinish: (value: ModelResponse["finishReason"]) => void,
  setUsage: (value: ModelResponse["usage"]) => void,
  setContinuation: (value: ModelResponse["continuationCursor"]) => void,
): void {
  if (event.type === "text_delta") addText(event.text)
  if (event.type === "reasoning_summary_delta") addReasoning(event.text)
  if (event.type === "tool_call_completed") calls.set(event.callId, { id: event.callId, name: event.name, arguments: event.arguments })
  if (event.type === "usage") setUsage({ inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd ?? 0 })
  if (event.type === "continuation") setContinuation(event.continuation.cursor ?? event.continuation.providerResponseId ?? null)
  if (event.type === "completed") setFinish(event.finishReason)
}
