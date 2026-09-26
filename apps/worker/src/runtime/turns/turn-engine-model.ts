import {
  completeStructuredStep,
  type HarnessModelRequest,
  type ModelAdapter,
  type ModelContinuation,
  type ModelResponse,
  type ModelStreamEvent,
} from "@jobcopilot/agent-model"

import type { TurnEngineToolCall } from "./turn-engine-types.js"
import { TurnEngineError } from "./turn-engine-types.js"

export type ModelStepResult = {
  readonly text: string
  readonly reasoningSummary: string
  readonly toolCalls: readonly TurnEngineToolCall[]
  readonly provider: string
  readonly model: string
  readonly finishReason: ModelResponse["finishReason"]
  readonly usage: ModelResponse["usage"]
  readonly continuation: ModelContinuation | null
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
  let provider = request.provider
  let model = request.model
  let continuation: ModelContinuation | null = null
  const calls = new Map<string, TurnEngineToolCall>()
  let completed = false
  for await (const event of adapter.stream(request)) {
    if (completed) throw new TurnEngineError("invalid_output", "Model stream emitted data after completion")
    if (event.type === "completed") {
      completed = true
      if (finishReason) throw new TurnEngineError("invalid_output", "Model stream emitted multiple completion events")
    }
    consume(event, calls, validateToolArguments, (value) => { text += value }, (value) => { reasoningSummary += value }, (value) => { finishReason = value }, (value) => { usage = value }, (value) => { continuation = value }, (value) => { provider = value }, (value) => { model = value })
  }
  if (!completed || !finishReason) throw new TurnEngineError("invalid_output", "Model stream completed without a finish reason")
  if (finishReason === "tool_calls" && calls.size === 0) throw new TurnEngineError("invalid_output", "Model tool-call completion contained no tool calls")
  if (finishReason !== "tool_calls" && calls.size > 0) throw new TurnEngineError("invalid_output", "Model stream returned tool calls with a non-tool completion")
  if (finishReason !== "stop" && finishReason !== "tool_calls") throw new TurnEngineError("invalid_output", "Model stream did not complete normally")
  return { text, reasoningSummary, toolCalls: [...calls.values()], provider, model, finishReason, usage, continuation }
}

async function runStructuredStep(
  adapter: ModelAdapter,
  request: HarnessModelRequest,
  validateToolArguments?: (toolName: string, input: unknown) => boolean | string,
): Promise<ModelStepResult> {
  const result = await completeStructuredStep(structuredAdapter(adapter), request, {
    validateToolArguments: (call) => validateToolArguments?.(call.tool, call.arguments) ?? "A tool arguments validator is required before execution",
  })
  if (result.step.kind === "call_tool") {
    return {
      text: "",
      reasoningSummary: result.step.rationaleSummary,
      toolCalls: [{ id: result.step.callId, name: result.step.tool, arguments: result.step.arguments }],
      provider: request.provider,
      model: request.model,
      finishReason: "tool_calls",
      usage: result.response.usage,
      continuation: result.response.continuationCursor ? { cursor: result.response.continuationCursor } : null,
    }
  }
  if (result.step.kind !== "finish") throw new TurnEngineError("invalid_output", `Structured model output requested unsupported action: ${result.step.kind}`)
  const response = result.step.response
  const text = typeof response.text === "string" ? response.text : JSON.stringify(response)
  return { text: text ?? "", reasoningSummary: "", toolCalls: [], provider: request.provider, model: request.model, finishReason: "stop", usage: result.response.usage, continuation: result.response.continuationCursor ? { cursor: result.response.continuationCursor } : null }
}

function structuredAdapter(adapter: ModelAdapter): ModelAdapter {
  return {
    ...adapter,
    ...(adapter.complete ? {
      complete: async (request: HarnessModelRequest): Promise<ModelResponse> => {
        const response = await adapter.complete!(request)
        assertStructuredFinish(response.finishReason)
        return response
      },
    } : {}),
    async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
      let completed = false
      for await (const event of adapter.stream(request)) {
        if (completed) throw new TurnEngineError("invalid_output", "Structured model stream emitted data after completion")
        if (event.type === "completed") {
          completed = true
          assertStructuredFinish(event.finishReason)
        }
        yield event
      }
    },
  }
}

function assertStructuredFinish(finishReason: ModelResponse["finishReason"]): void {
  if (finishReason !== "stop") throw new TurnEngineError("invalid_output", "Structured model response did not complete normally")
}

function consume(
  event: ModelStreamEvent,
  calls: Map<string, TurnEngineToolCall>,
  validateToolArguments: ((toolName: string, input: unknown) => boolean | string) | undefined,
  addText: (value: string) => void,
  addReasoning: (value: string) => void,
  setFinish: (value: ModelResponse["finishReason"]) => void,
  setUsage: (value: ModelResponse["usage"]) => void,
  setContinuation: (value: ModelContinuation) => void,
  setProvider: (value: string) => void,
  setModel: (value: string) => void,
): void {
  if (event.type === "text_delta") addText(event.text)
  if (event.type === "reasoning_summary_delta") addReasoning(event.text)
  if (event.type === "tool_call_completed") {
    if (typeof event.callId !== "string" || event.callId.trim().length === 0 || event.callId.length > 256) throw new TurnEngineError("invalid_output", "Model tool call id is invalid")
    if (typeof event.name !== "string" || event.name.trim().length === 0 || event.name.length > 256) throw new TurnEngineError("invalid_output", "Model tool name is invalid")
    if (calls.has(event.callId)) throw new TurnEngineError("invalid_output", "Model stream repeated a tool call id")
    if (!validateToolArguments) throw new TurnEngineError("invalid_output", "A tool arguments validator is required before execution")
    const validation = validateToolArguments(event.name, event.arguments)
    if (validation !== true) throw new TurnEngineError("invalid_output", typeof validation === "string" ? validation : "Model tool arguments failed validation")
    calls.set(event.callId, { id: event.callId, name: event.name, arguments: event.arguments })
  }
  if (event.type === "usage") {
    setUsage({ inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd ?? 0 })
    if (event.provider) setProvider(event.provider)
    if (event.model) setModel(event.model)
  }
  if (event.type === "continuation") setContinuation(event.continuation)
  if (event.type === "completed") setFinish(event.finishReason)
}
