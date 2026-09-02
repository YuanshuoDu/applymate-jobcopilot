import { isSafeAiEndpoint } from "@jobcopilot/shared/safe-ai-endpoint"
import { AgentModelError } from "../../errors.js"
import type { HarnessModelRequest, ModelCapabilityProfile } from "../../contracts.js"
import type {
  OpenAiCompatibleAdapterOptions,
  OpenAiCompatibleConfig,
  OpenAiRequest,
  OpenAiWireMode,
} from "./types.js"
type ProviderMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: readonly ProviderToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }
type ProviderToolCall = {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}
export function buildOpenAiRequest(
  request: HarnessModelRequest,
  config: OpenAiCompatibleConfig,
  options: OpenAiCompatibleAdapterOptions = {},
): OpenAiRequest {
  const mode = options.mode ?? config.mode ?? "chat_completions"
  const baseUrl = validateBaseUrl(config.baseUrl, options.allowLocalDevelopment === true)
  if (!config.apiKey.trim()) throw configurationError("OpenAI-compatible adapter requires an API key", config)
  const messages = request.messages.flatMap((message) => toProviderMessages(message, config))
  const tools = request.tools.map((tool) => toProviderTool(tool, mode, config))
  const body = mode === "responses"
    ? buildResponsesBody(request, config, messages, tools)
    : buildChatCompletionsBody(request, config, messages, tools)
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  }
  if (config.organization) headers["OpenAI-Organization"] = config.organization
  return { url: endpointUrl(baseUrl, mode), headers, body, mode }
}
export function capabilityProfile(
  config: Pick<OpenAiCompatibleConfig, "provider" | "model">,
  mode: OpenAiWireMode,
  overrides: Partial<ModelCapabilityProfile> = {},
): ModelCapabilityProfile {
  const continuation = mode === "responses"
  return {
    provider: config.provider,
    model: config.model,
    nativeTools: true,
    structuredOutput: true,
    streaming: true,
    continuationCursor: continuation,
    supportsParallelTools: true,
    supportsStreamingToolArgs: true,
    supportsReasoningSummary: false,
    supportsResponseContinuation: continuation,
    supportsProviderConversation: continuation,
    supportsBackgroundResponse: false,
    maxContextTokens: null,
    maxOutputTokens: null,
    costClass: "unknown",
    ...overrides,
  }
}
function buildChatCompletionsBody(
  request: HarnessModelRequest,
  config: OpenAiCompatibleConfig,
  messages: ProviderMessage[],
  tools: unknown[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens
  if (tools.length > 0) body.tools = tools
  if (request.toolChoice !== undefined) body.tool_choice = chatToolChoice(request.toolChoice)
  if (request.outputSchema !== undefined) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "harness_output", schema: request.outputSchema, strict: true },
    }
  }
  if (request.continuation && hasContinuation(request)) {
    throw unsupportedContinuation("Chat Completions does not support provider continuation", config)
  }
  return body
}
function buildResponsesBody(
  request: HarnessModelRequest,
  config: OpenAiCompatibleConfig,
  messages: ProviderMessage[],
  tools: unknown[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    input: messages.flatMap(toResponsesInput),
    stream: true,
  }
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens
  if (tools.length > 0) body.tools = tools
  if (request.toolChoice !== undefined) body.tool_choice = responsesToolChoice(request.toolChoice)
  if (request.outputSchema !== undefined) {
    body.text = {
      format: { type: "json_schema", name: "harness_output", schema: request.outputSchema, strict: true },
    }
  }
  const continuation = request.continuation
  if (continuation?.providerResponseId ?? continuation?.cursor) {
    body.previous_response_id = continuation.providerResponseId ?? continuation.cursor
  }
  if (continuation?.providerConversationId) body.conversation = continuation.providerConversationId
  return body
}
function toProviderMessages(message: HarnessModelRequest["messages"][number], config: OpenAiCompatibleConfig): ProviderMessage[] {
  const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
  const toolUses = message.content.filter((part): part is Extract<typeof part, { type: "tool_use" }> => part.type === "tool_use")
  const toolResults = message.content.filter((part): part is Extract<typeof part, { type: "tool_result" }> => part.type === "tool_result")
  if (message.role === "tool") {
    if (toolResults.length === 0) throw unsupportedInput("OpenAI-compatible tool messages require tool_result blocks", config)
    return toolResults.map((part) => ({ role: "tool", tool_call_id: part.toolUseId, content: part.content }))
  }
  if (toolUses.length > 0) {
    if (message.role !== "assistant" || toolResults.length > 0) throw unsupportedInput("Tool calls are only valid in assistant messages", config)
    return [{
      role: "assistant",
      content: text || null,
      tool_calls: toolUses.map((part) => ({
        id: part.id,
        type: "function" as const,
        function: { name: part.name, arguments: jsonArguments(part.input) },
      })),
    }]
  }
  if (toolResults.length > 0 || message.role === "assistant" && !text) throw unsupportedInput("OpenAI-compatible messages contain unsupported content", config)
  if (message.role === "system" || message.role === "user" || message.role === "assistant") return [{ role: message.role, content: text }]
  throw unsupportedInput("OpenAI-compatible messages contain unsupported content", config)
}
function toResponsesInput(message: ProviderMessage): Array<Record<string, unknown>> {
  if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }]
  const items: Array<Record<string, unknown>> = []
  if (message.content) items.push({ role: message.role, content: [{ type: "input_text", text: message.content }] })
  if (message.role === "assistant" && message.tool_calls) {
    for (const call of message.tool_calls) items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments })
  }
  return items
}
function jsonArguments(value: unknown): string {
  const result = JSON.stringify(value)
  return result === undefined ? "{}" : result
}
function toProviderTool(tool: unknown, mode: OpenAiWireMode, config: OpenAiCompatibleConfig): unknown {
  const value = asRecord(tool, "OpenAI-compatible tool")
  if (value.type === "function") {
    const functionValue = asRecord(value.function, "OpenAI-compatible function tool")
    const name = requiredString(functionValue.name, "OpenAI-compatible function tool name", config)
    const description = optionalString(functionValue.description)
    const parameters = functionValue.parameters
    if (parameters === undefined) throw unsupportedInput("OpenAI-compatible function tool is missing parameters", config)
    if (mode === "chat_completions") return {
      type: "function",
      function: { name, ...(description ? { description } : {}), parameters },
    }
    return { type: "function", name, ...(description ? { description } : {}), parameters }
  }
  const name = requiredString(value.name, "OpenAI-compatible tool name", config)
  const parameters = value.inputSchema ?? value.parameters
  if (parameters === undefined) throw unsupportedInput("OpenAI-compatible tool is missing inputSchema", config)
  const description = optionalString(value.description)
  if (mode === "chat_completions") return {
    type: "function",
    function: { name, ...(description ? { description } : {}), parameters },
  }
  return { type: "function", name, ...(description ? { description } : {}), parameters }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentModelError({
    code: "unsupported_input", message: `${label} must be an object`, recoverable: true,
  })
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string, config: OpenAiCompatibleConfig): string {
  const result = optionalString(value)
  if (!result) throw unsupportedInput(`${label} is required`, config)
  return result
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function validateBaseUrl(rawUrl: string, allowLocalDevelopment: boolean): URL {
  if (!isSafeAiEndpoint(rawUrl, { allowLocalDevelopment })) throw new AgentModelError({
    code: "configuration_error",
    message: "OpenAI-compatible endpoint is not allowed",
    recoverable: false,
  })
  const url = new URL(rawUrl)
  if (url.search || url.hash) throw new AgentModelError({
    code: "configuration_error",
    message: "OpenAI-compatible endpoint must not contain query or fragment data",
    recoverable: false,
  })
  return url
}

function endpointUrl(baseUrl: URL, mode: OpenAiWireMode): string {
  const suffix = mode === "responses" ? "responses" : "chat/completions"
  const path = `${baseUrl.pathname.replace(/\/+$/, "")}/${suffix}`
  baseUrl.pathname = path
  baseUrl.search = ""
  baseUrl.hash = ""
  return baseUrl.toString()
}

function hasContinuation(request: HarnessModelRequest): boolean {
  const continuation = request.continuation
  return Boolean(continuation?.cursor || continuation?.providerResponseId || continuation?.providerConversationId)
}

function chatToolChoice(choice: NonNullable<HarnessModelRequest["toolChoice"]>): unknown {
  if (typeof choice === "string") return choice
  return { type: "function", function: { name: choice.name } }
}

function responsesToolChoice(choice: NonNullable<HarnessModelRequest["toolChoice"]>): unknown {
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.name }
}

function configurationError(message: string, config: OpenAiCompatibleConfig): AgentModelError {
  return new AgentModelError({ code: "configuration_error", message, provider: config.provider, model: config.model })
}

function unsupportedContinuation(message: string, config: OpenAiCompatibleConfig): AgentModelError {
  return new AgentModelError({
    code: "unsupported_capability", message, provider: config.provider, model: config.model, recoverable: true,
  })
}

function unsupportedInput(message: string, config: OpenAiCompatibleConfig): AgentModelError {
  return new AgentModelError({
    code: "unsupported_input", message, provider: config.provider, model: config.model, recoverable: true,
  })
}
