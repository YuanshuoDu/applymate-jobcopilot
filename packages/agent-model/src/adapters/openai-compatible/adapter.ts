import { pinnedFetch } from "@jobcopilot/shared/pinned-outbound"
import { AgentModelError, cancellationError } from "../../errors.js"
import { MODEL_SCHEMA_VERSION, type HarnessModelRequest, type ModelAdapter, type ModelResponse, type ModelStreamEvent, type ModelToolCall } from "../../contracts.js"
import { buildOpenAiRequest, capabilityProfile } from "./request.js"
import { ChatCompletionsParser, ResponsesParser } from "./parser.js"
import { readServerSentEvents } from "./sse.js"
import type { OpenAiCompatibleAdapter, OpenAiCompatibleAdapterOptions, OpenAiCompatibleConfig, OpenAiFetch, OpenAiWireMode } from "./types.js"

const DEFAULT_TIMEOUT_MS = 120_000

export function createOpenAiCompatibleAdapter(
  config: OpenAiCompatibleConfig,
  options: OpenAiCompatibleAdapterOptions = {},
): OpenAiCompatibleAdapter {
  const mode = options.mode ?? config.mode ?? "chat_completions"
  const profile = capabilityProfile(config, mode, options.profile)
  const fetcher = options.fetch ?? ((url, init) => defaultFetch(url, init, options.allowLocalDevelopment === true))
  const timeoutMs = config.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new AgentModelError({
    code: "configuration_error", message: "OpenAI-compatible timeout must be a positive integer",
    provider: config.provider, model: config.model,
  })
  return {
    id: `openai-compatible:${config.provider}:${config.model}:${mode}`,
    profile,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    stream: (request) => streamOpenAi(config, options, profile, request, fetcher, timeoutMs),
    complete: (request) => completeOpenAi(config, options, profile, request, fetcher, timeoutMs),
  }
}

async function* streamOpenAi(
  config: OpenAiCompatibleConfig,
  options: OpenAiCompatibleAdapterOptions,
  profile: ReturnType<typeof capabilityProfile>,
  request: HarnessModelRequest,
  fetcher: OpenAiFetch,
  timeoutMs: number,
): AsyncIterable<ModelStreamEvent> {
  assertRequest(profile, request)
  if (request.signal.aborted) throw cancellationError(request)
  const abort = linkedAbort(request.signal, timeoutMs)
  try {
    const outbound = buildOpenAiRequest(request, config, options)
    const response = await fetchWithAbort(fetcher(outbound.url, {
      method: "POST", headers: outbound.headers, body: JSON.stringify(outbound.body), signal: abort.signal,
    }), abort.signal)
    if (!response.ok) throwHttpError(response, request, config)
    if (!response.body) throw malformed("OpenAI-compatible response has no stream body", config)
    const parser = outbound.mode === "responses" ? new ResponsesParser() : new ChatCompletionsParser()
    let doneMarker = false
    let terminal = false
    for await (const serverEvent of readServerSentEvents(response.body, abort.signal)) {
      if (serverEvent.data.trim() === "[DONE]") {
        doneMarker = true
        break
      }
      let data: unknown
      try {
        data = JSON.parse(serverEvent.data) as unknown
      } catch {
        throw malformed("OpenAI-compatible stream contained invalid JSON", config)
      }
      const result = parser.consume(serverEvent.event, data)
      for (const event of result.events) yield event
      if (result.terminal) {
        terminal = true
        break
      }
    }
    if (outbound.mode === "chat_completions") {
      if (!doneMarker) throw malformed("Chat Completions stream ended without [DONE]", config)
      for (const event of parser.finish()) yield event
    } else if (!terminal) {
      for (const event of parser.finish()) yield event
    }
  } catch (error) {
    throw normalizeError(error, request, config, abort.timedOut())
  } finally {
    abort.dispose()
    abort.abort()
  }
}

async function completeOpenAi(
  config: OpenAiCompatibleConfig,
  options: OpenAiCompatibleAdapterOptions,
  profile: ReturnType<typeof capabilityProfile>,
  request: HarnessModelRequest,
  fetcher: OpenAiFetch,
  timeoutMs: number,
): Promise<ModelResponse> {
  let text = ""
  let finishReason: ModelResponse["finishReason"] | undefined
  let usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null = null
  let continuationCursor: string | null = null
  const toolCalls: ModelToolCall[] = []
  for await (const event of streamOpenAi(config, options, profile, request, fetcher, timeoutMs)) {
    if (event.type === "text_delta") text += event.text
    if (event.type === "usage") usage = {
      inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd ?? 0,
    }
    if (event.type === "tool_call_completed") toolCalls.push({ id: event.callId, name: event.name, arguments: event.arguments })
    if (event.type === "continuation") continuationCursor = event.continuation.cursor ?? event.continuation.providerResponseId ?? null
    if (event.type === "completed") finishReason = event.finishReason
  }
  if (!finishReason) throw malformed("OpenAI-compatible stream did not complete", config)
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

function defaultFetch(url: string, init: Parameters<OpenAiFetch>[1], allowLocalDevelopment = false): Promise<Response> {
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
    throw new AgentModelError({ code: "invalid_request", message: "Model request does not match the adapter profile", provider: request.provider, model: request.model })
  }
}

function throwHttpError(response: Response, request: HarnessModelRequest, config: OpenAiCompatibleConfig): never {
  const continuationRequested = Boolean(request.continuation?.cursor || request.continuation?.providerResponseId || request.continuation?.providerConversationId)
  const cursorLost = continuationRequested && (response.status === 400 || response.status === 404)
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
  const code = cursorLost ? "cursor_lost" : response.status === 408 || response.status === 504 ? "timeout" : response.status === 401 || response.status === 403 ? "configuration_error" : "provider_error"
  throw new AgentModelError({
    code,
    message: cursorLost ? "Provider continuation cursor is no longer valid" : `OpenAI-compatible provider returned HTTP ${response.status}`,
    provider: config.provider,
    model: config.model,
    retryable: code === "provider_error" || code === "timeout" || response.status === 429,
    recoverable: code !== "configuration_error",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

function normalizeError(error: unknown, request: HarnessModelRequest, config: OpenAiCompatibleConfig, timedOut: boolean): AgentModelError {
  if (request.signal.aborted) return cancellationError(request)
  if (timedOut) return new AgentModelError({ code: "timeout", message: "OpenAI-compatible model request timed out", provider: config.provider, model: config.model, retryable: true, recoverable: true })
  if (error instanceof AgentModelError) return error
  if (isAbortError(error)) return new AgentModelError({ code: "cancelled", message: "OpenAI-compatible model request cancelled", provider: config.provider, model: config.model, recoverable: true })
  return new AgentModelError({ code: "provider_error", message: "OpenAI-compatible model request failed", provider: config.provider, model: config.model, retryable: true, recoverable: true })
}

function malformed(message: string, config: OpenAiCompatibleConfig): AgentModelError {
  return new AgentModelError({ code: "malformed_response", message, provider: config.provider, model: config.model, recoverable: true })
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError")
}

function linkedAbort(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void; abort: () => void } {
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
