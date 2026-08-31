import { AgentModelError, cancellationError } from "./errors.js"
import {
  MODEL_SCHEMA_VERSION,
  type HarnessModelRequest,
  type ModelAdapter,
  type ModelCapabilityProfile,
  type ModelResponse,
  type ModelStreamEvent,
} from "./contracts.js"

export interface LegacyTextMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LegacyUsageContext {
  userId?: string
  featureKey?: string
  runtime?: "web" | "worker" | "admin" | "unknown"
}

export interface LegacyChatResult {
  text: string
  inputTokens?: number
  outputTokens?: number
  provider: string
  model: string
}

export interface LegacyModelClient<TConfig> {
  chat(messages: LegacyTextMessage[], config: TConfig, maxTokens: number, usageContext?: LegacyUsageContext): Promise<LegacyChatResult>
  stream?(messages: LegacyTextMessage[], config: TConfig, maxTokens: number, usageContext?: LegacyUsageContext): AsyncIterable<string>
}

export interface LegacyModelFacade<TConfig> {
  chat(messages: LegacyTextMessage[], config: TConfig, maxTokens?: number, usageContext?: LegacyUsageContext): Promise<LegacyChatResult>
  createAdapter(config: TConfig, profile: ModelCapabilityProfile, adapterId?: string): ModelAdapter
}

export interface LegacyModelFacadeOptions {
  runtime?: LegacyUsageContext["runtime"]
}

export function createLegacyModelFacade<TConfig>(
  client: LegacyModelClient<TConfig>,
  options: LegacyModelFacadeOptions = {},
): LegacyModelFacade<TConfig> {
  return {
    chat: (messages, config, maxTokens = 1_024, usageContext) => client.chat(messages, config, maxTokens, usageContext),
    createAdapter(config, profile, adapterId = `legacy:${profile.provider}:${profile.model}`) {
      return createAdapter(client, config, profile, adapterId, options.runtime)
    },
  }
}

function createAdapter<TConfig>(
  client: LegacyModelClient<TConfig>,
  config: TConfig,
  profile: ModelCapabilityProfile,
  adapterId: string,
  runtime: LegacyUsageContext["runtime"],
): ModelAdapter {
  return {
    id: adapterId,
    profile,
    stream: (request) => streamLegacy(client, config, profile, request, runtime),
    complete: (request) => completeLegacy(client, config, profile, request, runtime),
  }
}

async function* streamLegacy<TConfig>(
  client: LegacyModelClient<TConfig>,
  config: TConfig,
  profile: ModelCapabilityProfile,
  request: HarnessModelRequest,
  runtime: LegacyUsageContext["runtime"],
): AsyncIterable<ModelStreamEvent> {
  assertRequest(profile, request)
  const messages = toLegacyMessages(request, profile)
  const maxTokens = request.maxOutputTokens ?? 1_024
  try {
    throwIfAborted(request)
    if (client.stream) {
      for await (const text of client.stream(messages, config, maxTokens, usageContext(request, runtime))) {
        throwIfAborted(request)
        if (text) yield { type: "text_delta", text }
      }
      yield { type: "completed", finishReason: "stop" }
      return
    }
    const result = await client.chat(messages, config, maxTokens, usageContext(request, runtime))
    throwIfAborted(request)
    yield* resultEvents(result)
  } catch (error) {
    throw normalizeError(error, profile, request)
  }
}

async function completeLegacy<TConfig>(
  client: LegacyModelClient<TConfig>,
  config: TConfig,
  profile: ModelCapabilityProfile,
  request: HarnessModelRequest,
  runtime: LegacyUsageContext["runtime"],
): Promise<ModelResponse> {
  assertRequest(profile, request)
  try {
    throwIfAborted(request)
    const result = await client.chat(toLegacyMessages(request, profile), config, request.maxOutputTokens ?? 1_024, usageContext(request, runtime))
    throwIfAborted(request)
    return {
      schemaVersion: MODEL_SCHEMA_VERSION,
      provider: result.provider,
      model: result.model,
      finishReason: "stop",
      text: result.text,
      toolCalls: [],
      usage: result.inputTokens === undefined || result.outputTokens === undefined
        ? null
        : { inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedCostUsd: 0 },
      continuationCursor: null,
    }
  } catch (error) {
    throw normalizeError(error, profile, request)
  }
}

function* resultEvents(result: LegacyChatResult): Generator<ModelStreamEvent> {
  if (result.text) yield { type: "text_delta", text: result.text }
  if (result.inputTokens !== undefined && result.outputTokens !== undefined) {
    yield { type: "usage", inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedCostUsd: 0 }
  }
  yield { type: "completed", finishReason: "stop" }
}

function toLegacyMessages(request: HarnessModelRequest, profile: ModelCapabilityProfile): LegacyTextMessage[] {
  return request.messages.map((message) => {
    if (message.role === "tool") throw new AgentModelError({
      code: "unsupported_input", message: "Legacy model clients cannot receive tool messages",
      provider: profile.provider, model: profile.model, recoverable: true,
    })
    const text = message.content.map((part) => {
      if (part.type !== "text") throw new AgentModelError({
        code: "unsupported_input", message: "Legacy model clients support text content only",
        provider: profile.provider, model: profile.model, recoverable: true,
      })
      return part.text
    }).join("")
    return { role: message.role, content: text }
  })
}

function usageContext(request: HarnessModelRequest, runtime: LegacyUsageContext["runtime"]): LegacyUsageContext {
  return { userId: request.metadata.userId, featureKey: request.metadata.featureId, runtime }
}

function assertRequest(profile: ModelCapabilityProfile, request: HarnessModelRequest): void {
  if (request.schemaVersion !== MODEL_SCHEMA_VERSION || request.provider !== profile.provider ||
    (profile.model !== "*" && request.model !== profile.model)) {
    throw new AgentModelError({
      code: "invalid_request", message: "Model request does not match the adapter profile",
      provider: request.provider, model: request.model, recoverable: false,
    })
  }
}

function throwIfAborted(request: HarnessModelRequest): void {
  if (request.signal.aborted) throw cancellationError(request)
}

function normalizeError(error: unknown, profile: ModelCapabilityProfile, request: HarnessModelRequest): AgentModelError {
  if (error instanceof AgentModelError) return error
  if (request.signal.aborted) return cancellationError(request)
  return new AgentModelError({
    code: "provider_error", message: "Legacy model client failed",
    provider: profile.provider, model: profile.model, retryable: true, recoverable: true,
  })
}
