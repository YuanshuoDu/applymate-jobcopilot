import { AgentModelError } from "../../errors.js"
import {
  resolveMiniMaxBaseUrl as resolveSharedMiniMaxBaseUrl,
} from "@jobcopilot/shared/minimax"
import {
  MINIMAX_DEFAULT_MAX_COMPLETION_TOKENS,
  type MiniMaxConfig,
  type MiniMaxCredentials,
  type MiniMaxRequestOptions,
  type MiniMaxThinkingMode,
} from "./types.js"

export function resolveMiniMaxBaseUrl(
  config: Pick<MiniMaxConfig, "baseUrl" | "apiBase" | "region"> = {},
): string {
  const environment = readEnvironment()
  return resolveSharedMiniMaxBaseUrl({
    ...config,
    environmentBaseUrl: environment.MINIMAX_BASE_URL,
    environmentRegion: environment.MINIMAX_REGION,
  })
}

export function resolveMiniMaxCredentials(config: Pick<MiniMaxConfig, "apiKey" | "platformApiKey"> = {}): MiniMaxCredentials {
  const userKey = clean(config.apiKey)
  if (userKey) return { apiKey: userKey, credentialSource: "user" }
  const platformKey = clean(config.platformApiKey) ?? environmentPlatformKey()
  return { apiKey: platformKey ?? "", credentialSource: "platform" }
}

export function miniMaxRequestOptions(config: MiniMaxConfig, model: string): MiniMaxRequestOptions {
  const maxCompletionTokens = config.maxCompletionTokens ?? MINIMAX_DEFAULT_MAX_COMPLETION_TOKENS
  if (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens <= 0) throw new AgentModelError({
    code: "configuration_error",
    message: "MiniMax maxCompletionTokens must be a positive integer",
    provider: "minimax",
    model,
  })
  return {
    model,
    maxCompletionTokens,
    reasoningSplit: config.reasoningSplit ?? true,
    thinking: config.thinking ?? "adaptive",
  }
}

/** Translate the generic Chat Completions body to MiniMax's current fields. */
export function buildMiniMaxRequestBody(body: string, options: MiniMaxRequestOptions): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw malformed("MiniMax request body is not valid JSON", options.model)
  }
  if (!isRecord(parsed)) throw malformed("MiniMax request body must be an object", options.model)
  const result: Record<string, unknown> = { ...parsed, model: options.model }
  const legacyLimit = result.max_tokens
  delete result.max_tokens
  if (legacyLimit !== undefined) {
    if (!Number.isSafeInteger(legacyLimit) || (legacyLimit as number) <= 0) {
      throw malformed("MiniMax max_tokens must be a positive integer", options.model)
    }
    result.max_completion_tokens = legacyLimit
  } else if (result.max_completion_tokens === undefined) {
    result.max_completion_tokens = options.maxCompletionTokens
  }
  result.reasoning_split = options.reasoningSplit
  if (options.model === "MiniMax-M3") result.thinking = { type: options.thinking }
  else delete result.thinking
  return JSON.stringify(result)
}

function environmentPlatformKey(): string | undefined {
  return clean(readEnvironment().MINIMAX_API_KEY)
}

function readEnvironment(): Record<string, string | undefined> {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
  return runtime.process?.env ?? {}
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function malformed(message: string, model: string): AgentModelError {
  return new AgentModelError({ code: "invalid_request", message, provider: "minimax", model, recoverable: true })
}

export type { MiniMaxThinkingMode }
