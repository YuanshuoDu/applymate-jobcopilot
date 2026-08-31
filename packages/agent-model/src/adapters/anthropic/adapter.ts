import { pinnedFetch } from "@jobcopilot/shared/pinned-outbound"
import { AgentModelError, cancellationError } from "../../errors.js"
import {
  MODEL_SCHEMA_VERSION,
  type HarnessModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall,
} from "../../contracts.js"
import { readServerSentEvents } from "../openai-compatible/sse.js"
import { AnthropicMessagesParser } from "./parser.js"
import { buildAnthropicRequest } from "./request.js"
import type {
  AnthropicAdapter,
  AnthropicAdapterOptions,
  AnthropicConfig,
  AnthropicFetch,
} from "./types.js"

const DEFAULT_TIMEOUT_MS = 120_000

export function createAnthropicAdapter(
  config: AnthropicConfig,
  options: AnthropicAdapterOptions = {},
): AnthropicAdapter {
  const profile = capabilityProfile(config, options.profile)
  const fetcher = options.fetch ?? ((url, init) => defaultFetch(url, init, options.allowLocalDevelopment === true))
  const timeoutMs = config.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new AgentModelError({
    code: "configuration_error", message: "Anthropic timeout must be a positive integer",
    provider: config.provider, model: config.model,
  })
  return {
    id: `anthropic:${config.provider}:${config.model}`,
    profile,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    stream: (request) => streamAnthropic(config, options, profile, request, fetcher, timeoutMs),
    complete: (request) => completeAnthropic(config, options, profile, request, fetcher, timeoutMs),
  }
}

function capabilityProfile(
  config: Pick<AnthropicConfig, "provider" | "model">,
  overrides: AnthropicAdapterOptions["profile"] = {},
) {
  return {
    provider: config.provider,
    model: config.model,
    nativeTools: true,
    structuredOutput: false,
    streaming: true,
    continuationCursor: false,
    supportsParallelTools: true,
    supportsStreamingToolArgs: true,
    supportsReasoningSummary: false,
    supportsResponseContinuation: false,
    supportsProviderConversation: false,
    supportsBackgroundResponse: false,
    maxContextTokens: null,
    maxOutputTokens: null,
    costClass: "unknown" as const,
    ...overrides,
  }
}

async function* streamAnthropic(
  config: AnthropicConfig,
  options: AnthropicAdapterOptions,
  profile: ReturnType<typeof capabilityProfile>,
  request: HarnessModelRequest,
  fetcher: AnthropicFetch,
  timeoutMs: number,
): AsyncIterable<ModelStreamEvent> {
  assertRequest(profile, request)
  if (request.signal.aborted) throw cancellationError(request)
  const abort = linkedAbort(request.signal, timeoutMs)
  try {
    const outbound = buildAnthropicRequest(request, config, { allowLocalDevelopment: options.allowLocalDevelopment })
    const response = await fetchWithAbort(fetcher(outbound.url, {
      method: "POST", headers: outbound.headers, body: JSON.stringify(outbound.body), signal: abort.signal,
    }), abort.signal)
    if (!response.ok) throwHttpError(response, request, config)
    if (!response.body) throw malformed("Anthropic response has no stream body", config)
    const parser = new AnthropicMessagesParser(outbound.toolNameMap)
    let terminal = false
    for await (const serverEvent of readServerSentEvents(response.body, abort.signal)) {
      if (!serverEvent.data.trim()) continue
      let data: unknown
      try {
        data = JSON.parse(serverEvent.data) as unknown
      } catch {
        throw malformed("Anthropic stream contained invalid JSON", config)
      }
      const result = parser.consume(serverEvent.event, data)
      for (const event of result.events) yield event
      if (result.terminal) {
        terminal = true
        break
      }
    }
    if (!terminal) yield* parser.finish()
  } catch (error) {
    throw normalizeError(error, request, config, abort.timedOut())
  } finally {
    abort.dispose()
    abort.abort()
  }
}

async function completeAnthropic(
  config: AnthropicConfig,
  options: AnthropicAdapterOptions,
  profile: ReturnType<typeof capabilityProfile>,
  request: HarnessModelRequest,
  fetcher: AnthropicFetch,
  timeoutMs: number,
): Promise<ModelResponse> {
  let text = ""
  let finishReason: ModelResponse["finishReason"] | undefined
  let usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null = null
  const toolCalls: ModelToolCall[] = []
  for await (const event of streamAnthropic(config, options, profile, request, fetcher, timeoutMs)) {
    if (event.type === "text_delta") text += event.text
    if (event.type === "usage") usage = {
      inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd ?? 0,
    }
    if (event.type === "tool_call_completed") toolCalls.push({ id: event.callId, name: event.name, arguments: event.arguments })
    if (event.type === "completed") finishReason = event.finishReason
  }
  if (!finishReason) throw malformed("Anthropic stream did not complete", config)
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: request.provider,
    model: request.model,
    finishReason,
    ...(text ? { text } : {}),
    toolCalls,
    usage,
    continuationCursor: null,
  }
}

function defaultFetch(url: string, init: Parameters<AnthropicFetch>[1], allowLocalDevelopment = false): Promise<Response> {
  return pinnedFetch(url, { ...init, allowLocalDevelopment })
}

async function fetchWithAbort(fetchPromise: Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError")
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    fetchPromise.then(
      response => { signal.removeEventListener("abort", onAbort); resolve(response) },
      error => { signal.removeEventListener("abort", onAbort); reject(error) },
    )
  })
}

function assertRequest(profile: ReturnType<typeof capabilityProfile>, request: HarnessModelRequest): void {
  if (request.schemaVersion !== MODEL_SCHEMA_VERSION || request.provider !== profile.provider || request.model !== profile.model) {
    throw new AgentModelError({
      code: "invalid_request", message: "Model request does not match the Anthropic adapter profile",
      provider: request.provider, model: request.model, recoverable: true,
    })
  }
}

function throwHttpError(response: Response, request: HarnessModelRequest, config: AnthropicConfig): never {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
  const code = response.status === 408 || response.status === 504 ? "timeout"
    : response.status === 401 || response.status === 403 ? "configuration_error" : "provider_error"
  throw new AgentModelError({
    code,
    message: `Anthropic provider returned HTTP ${response.status}`,
    provider: config.provider,
    model: config.model,
    retryable: code === "provider_error" || code === "timeout" || response.status === 429,
    recoverable: code !== "configuration_error",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

function normalizeError(error: unknown, request: HarnessModelRequest, config: AnthropicConfig, timedOut: boolean): AgentModelError {
  if (request.signal.aborted) return cancellationError(request)
  if (timedOut) return new AgentModelError({
    code: "timeout", message: "Anthropic model request timed out", provider: config.provider, model: config.model,
    retryable: true, recoverable: true,
  })
  if (error instanceof AgentModelError) return error
  if (isAbortError(error)) return new AgentModelError({
    code: "cancelled", message: "Anthropic model request cancelled", provider: config.provider, model: config.model,
    recoverable: true,
  })
  return new AgentModelError({
    code: "provider_error", message: "Anthropic model request failed", provider: config.provider, model: config.model,
    retryable: true, recoverable: true,
  })
}

function malformed(message: string, config: AnthropicConfig): AgentModelError {
  return new AgentModelError({
    code: "malformed_response", message, provider: config.provider, model: config.model, recoverable: true,
  })
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function linkedAbort(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController()
  let timeout = false
  const onAbort = () => controller.abort()
  parent.addEventListener("abort", onAbort, { once: true })
  if (parent.aborted) controller.abort()
  const timer = setTimeout(() => { timeout = true; controller.abort() }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", onAbort) },
    abort: () => controller.abort(),
  }
}
