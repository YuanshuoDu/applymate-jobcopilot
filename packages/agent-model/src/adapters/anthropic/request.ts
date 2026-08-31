import { isSafeAiEndpoint } from "@jobcopilot/shared/safe-ai-endpoint"
import { AgentModelError } from "../../errors.js"
import type { HarnessModelRequest } from "../../contracts.js"
import type {
  AnthropicConfig,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./types.js"

const DEFAULT_BASE_URL = "https://api.anthropic.com"
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

type AnthropicMessage = {
  role: "user" | "assistant"
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock>
}

export function buildAnthropicRequest(
  request: HarnessModelRequest,
  config: AnthropicConfig,
  options: { allowLocalDevelopment?: boolean } = {},
): AnthropicRequest {
  const baseUrl = validateBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL, options.allowLocalDevelopment === true, config)
  if (!config.apiKey.trim()) throw configurationError("Anthropic adapter requires an API key", config)
  if (hasContinuation(request)) throw unsupported("Anthropic Messages does not support provider continuation", config)
  if (request.outputSchema !== undefined) throw unsupported("Anthropic adapter does not support structured output yet", config)

  const toolNameMap = new Map<string, string>()
  const tools = request.tools.map((tool) => toProviderTool(tool, config, toolNameMap))
  const systemParts: string[] = []
  const messages: AnthropicMessage[] = []
  for (const message of request.messages) {
    if (message.role === "system") {
      systemParts.push(...messageText(message.content, config))
      continue
    }
    messages.push(toProviderMessage(message, config, toolNameMap))
  }

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: request.maxOutputTokens ?? 1_024,
    messages,
    stream: true,
  }
  if (systemParts.length > 0) body.system = systemParts.join("\n\n")
  if (tools.length > 0) body.tools = tools
  if (request.toolChoice !== undefined) body.tool_choice = toolChoice(request.toolChoice, config)

  return {
    url: endpointUrl(baseUrl),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "anthropic-version": config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
      "x-api-key": config.apiKey,
    },
    body,
    toolNameMap,
  }
}

function toProviderMessage(
  message: HarnessModelRequest["messages"][number],
  config: AnthropicConfig,
  toolNameMap: Map<string, string>,
): AnthropicMessage {
  if (message.role === "system") throw unsupported("System messages must be mapped to Anthropic system", config)
  if (message.role === "tool") {
    const content = mapContent(message.content, "tool", config, toolNameMap)
    if (!content.some((part) => part.type === "tool_result")) {
      throw unsupported("Anthropic tool messages require tool_result blocks with toolUseId", config)
    }
    return { role: "user", content: stableToolResultsFirst(content) }
  }
  const content = mapContent(message.content, message.role, config, toolNameMap)
  return {
    role: message.role,
    content: message.role === "user" ? stableToolResultsFirst(content) : content,
  }
}

function mapContent(
  parts: readonly unknown[],
  role: "user" | "assistant" | "tool",
  config: AnthropicConfig,
  toolNameMap: Map<string, string>,
): Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock> {
  return parts.map((part) => {
    const value = asRecord(part, "Anthropic content part", config)
    const type = requiredString(value.type, "Anthropic content part type", config)
    if (type === "text") {
      const text = requiredString(value.text, "Anthropic text content", config)
      if (role === "tool") return textBlock(text)
      return textBlock(text)
    }
    if (type === "attachment_ref") throw unsupported("Anthropic adapter does not support attachment references", config)
    if (type === "tool_use") {
      if (role !== "assistant") throw unsupported("tool_use blocks are only valid in assistant messages", config)
      return {
        type: "tool_use",
        id: requiredString(value.id, "Anthropic tool_use id", config),
        name: providerToolName(requiredString(value.name, "Anthropic tool_use name", config), toolNameMap),
        input: value.input,
      }
    }
    if (type === "tool_result") {
      if (role === "assistant") throw unsupported("tool_result blocks are not valid in assistant messages", config)
      const toolUseId = requiredString(value.toolUseId ?? value.tool_use_id, "Anthropic tool_result toolUseId", config)
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: toolResultContent(value.content, config),
        ...(value.isError === true || value.is_error === true ? { is_error: true } : {}),
      }
    }
    throw unsupported(`Anthropic content block type is not supported: ${type}`, config)
  })
}

function messageText(parts: readonly unknown[], config: AnthropicConfig): string[] {
  return parts.map((part) => {
    const value = asRecord(part, "Anthropic system content part", config)
    if (value.type !== "text") throw unsupported("Anthropic system messages support text only", config)
    return requiredString(value.text, "Anthropic system text", config)
  })
}

function toProviderTool(tool: unknown, config: AnthropicConfig, toolNameMap: Map<string, string>): Record<string, unknown> {
  const value = asRecord(tool, "Anthropic tool", config)
  const functionValue = value.type === "function" ? asRecord(value.function, "Anthropic function tool", config) : value
  const originalName = requiredString(functionValue.name, "Anthropic tool name", config)
  const parameters = functionValue.inputSchema ?? functionValue.parameters
  if (parameters === undefined) throw unsupported("Anthropic tool is missing inputSchema", config)
  const name = providerToolName(originalName, toolNameMap)
  const description = optionalString(functionValue.description)
  return { name, ...(description ? { description } : {}), input_schema: parameters }
}

function providerToolName(name: string, toolNameMap: Map<string, string>): string {
  if (TOOL_NAME_PATTERN.test(name)) return name
  const encoded = name.replace(/[^A-Za-z0-9_-]/g, (character) => `_x${character.codePointAt(0)!.toString(16)}_`)
  if (!TOOL_NAME_PATTERN.test(encoded)) throw new AgentModelError({
    code: "unsupported_input", message: "Anthropic tool name cannot be represented as a provider tool name", recoverable: true,
  })
  const existing = toolNameMap.get(encoded)
  if (existing && existing !== name) throw new AgentModelError({
    code: "unsupported_input", message: "Anthropic tool names collide after provider normalization", recoverable: true,
  })
  toolNameMap.set(encoded, name)
  return encoded
}

function toolResultContent(value: unknown, config: AnthropicConfig): string | AnthropicTextBlock[] {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) throw unsupported("Anthropic tool_result content must be text or text blocks", config)
  return value.map((part) => {
    const block = asRecord(part, "Anthropic tool_result text block", config)
    if (block.type !== "text") throw unsupported("Anthropic tool_result only supports text blocks", config)
    return textBlock(requiredString(block.text, "Anthropic tool_result text", config))
  })
}

function stableToolResultsFirst(content: Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock>) {
  return [...content.filter((part) => part.type === "tool_result"), ...content.filter((part) => part.type !== "tool_result")]
}

function textBlock(text: string): AnthropicTextBlock {
  return { type: "text", text }
}

function toolChoice(choice: NonNullable<HarnessModelRequest["toolChoice"]>, config: AnthropicConfig): Record<string, unknown> {
  if (choice === "auto" || choice === "none") return { type: choice }
  return { type: "tool", name: providerToolName(choice.name, new Map()) }
}

function validateBaseUrl(rawUrl: string, allowLocalDevelopment: boolean, config: AnthropicConfig): URL {
  if (!isSafeAiEndpoint(rawUrl, { allowLocalDevelopment })) throw configurationError("Anthropic endpoint is not allowed", config)
  const url = new URL(rawUrl)
  if (url.search || url.hash) throw configurationError("Anthropic endpoint must not contain query or fragment data", config)
  return url
}

function endpointUrl(baseUrl: URL): string {
  const path = baseUrl.pathname.replace(/\/+$/, "")
  baseUrl.pathname = path.endsWith("/v1") ? `${path}/messages` : `${path}/v1/messages`
  baseUrl.search = ""
  baseUrl.hash = ""
  return baseUrl.toString()
}

function hasContinuation(request: HarnessModelRequest): boolean {
  const continuation = request.continuation
  return Boolean(continuation?.cursor || continuation?.providerResponseId || continuation?.providerConversationId)
}

function asRecord(value: unknown, label: string, config: AnthropicConfig): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unsupported(`${label} must be an object`, config)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string, config: AnthropicConfig): string {
  if (typeof value !== "string" || !value.trim()) throw unsupported(`${label} is required`, config)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function configurationError(message: string, config: AnthropicConfig): AgentModelError {
  return new AgentModelError({ code: "configuration_error", message, provider: config.provider, model: config.model })
}

function unsupported(message: string, config: AnthropicConfig): AgentModelError {
  return new AgentModelError({
    code: "unsupported_input", message, provider: config.provider, model: config.model, recoverable: true,
  })
}
