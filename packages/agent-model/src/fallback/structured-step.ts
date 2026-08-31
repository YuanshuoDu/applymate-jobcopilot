import {
  MODEL_SCHEMA_VERSION,
  type HarnessModelRequest,
  type ModelAdapter,
  type ModelResponse,
} from "../contracts.js"
import { AgentModelError } from "../errors.js"
import {
  NextStepValidationError,
  parseNextStep,
  type NextStep,
  type NextStepParseOptions,
} from "./next-step.js"

export interface StructuredStepResult {
  step: NextStep
  response: ModelResponse
  repairAttempts: number
}

export async function completeStructuredStep(
  adapter: ModelAdapter,
  request: HarnessModelRequest,
  options: NextStepParseOptions = {},
): Promise<StructuredStepResult> {
  const response = adapter.complete
    ? await adapter.complete(request)
    : await collectStream(adapter, request)
  if (response.toolCalls.length > 0) throw new AgentModelError({
    code: "unsupported_input",
    message: "Structured fallback expects text output, not native tool calls",
    provider: response.provider,
    model: response.model,
    recoverable: false,
  })
  const parsed = await parseNextStep(response.text ?? "", { ...options, messages: request.messages })
  if (parsed.step.kind === "call_tool" && !options.validateToolArguments) {
    throw new NextStepValidationError([{
      path: "/arguments", keyword: "toolArguments", message: "A tool arguments validator is required before execution",
    }], parsed.repairAttempts)
  }
  return {
    step: parsed.step,
    repairAttempts: parsed.repairAttempts,
    response: responseForStep(response, parsed.step),
  }
}

async function collectStream(adapter: ModelAdapter, request: HarnessModelRequest): Promise<ModelResponse> {
  let text = ""
  let finishReason: ModelResponse["finishReason"] | undefined
  let usage: ModelResponse["usage"] = null
  let continuationCursor: string | null = null
  const toolCalls: ModelResponse["toolCalls"] = []
  for await (const event of adapter.stream(request)) {
    if (event.type === "text_delta") text += event.text
    if (event.type === "usage") usage = {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      estimatedCostUsd: event.estimatedCostUsd ?? 0,
    }
    if (event.type === "continuation") continuationCursor = event.continuation.cursor ?? event.continuation.providerResponseId ?? null
    if (event.type === "tool_call_completed") toolCalls.push({ id: event.callId, name: event.name, arguments: event.arguments })
    if (event.type === "completed") finishReason = event.finishReason
  }
  if (!finishReason) throw new AgentModelError({
    code: "malformed_response", message: "Structured fallback stream did not complete",
    provider: request.provider, model: request.model, recoverable: true,
  })
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: request.provider,
    model: request.model,
    finishReason,
    ...(text ? { text } : {}),
    toolCalls,
    usage,
    continuationCursor,
  }
}

function responseForStep(response: ModelResponse, step: NextStep): ModelResponse {
  if (step.kind !== "call_tool") return response
  return {
    ...response,
    finishReason: "tool_calls",
    toolCalls: [{ id: step.callId, name: step.tool, arguments: step.arguments }],
  }
}
