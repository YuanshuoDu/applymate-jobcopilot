import { pinnedFetch } from "@jobcopilot/shared/pinned-outbound"
import { AgentModelError } from "../../errors.js"
import { createOpenAiCompatibleAdapter } from "../openai-compatible/adapter.js"
import type { ModelCapabilityProfile } from "../../contracts.js"
import { buildMiniMaxRequestBody, miniMaxRequestOptions, resolveMiniMaxCredentials } from "./request.js"
import { normalizeMiniMaxReasoningResponse } from "./response.js"
import {
  MINIMAX_DEFAULT_BASE_URL,
  MINIMAX_DEFAULT_MODEL,
  type MiniMaxAdapter,
  type MiniMaxAdapterOptions,
  type MiniMaxConfig,
  type MiniMaxRequestOptions,
} from "./types.js"
import type { OpenAiFetch, OpenAiFetchInit } from "../openai-compatible/types.js"

const PROVIDER = "minimax"

export function createMiniMaxAdapter(
  config: MiniMaxConfig = {},
  options: MiniMaxAdapterOptions = {},
): MiniMaxAdapter {
  assertMiniMaxConfiguration(config)
  const model = config.model ?? MINIMAX_DEFAULT_MODEL
  const baseUrl = config.baseUrl ?? config.apiBase ?? MINIMAX_DEFAULT_BASE_URL
  const credentials = resolveMiniMaxCredentials(config)
  const providerOptions = miniMaxRequestOptions(config, model)
  const fetcher = createMiniMaxFetch(options, providerOptions)
  const delegate = createOpenAiCompatibleAdapter({
    provider: PROVIDER,
    model,
    baseUrl,
    apiKey: credentials.apiKey,
  }, {
    fetch: fetcher,
    allowLocalDevelopment: options.allowLocalDevelopment,
    timeoutMs: config.timeoutMs ?? options.timeoutMs,
    profile: profileOverrides(providerOptions, options.profile),
  })
  return {
    ...delegate,
    id: `minimax:${model}`,
    config: { model, baseUrl },
    credentialSource: credentials.credentialSource,
    reasoningSplit: providerOptions.reasoningSplit,
    thinking: providerOptions.thinking,
  }
}

export function createMiniMaxM3Adapter(
  config: MiniMaxConfig = {},
  options: MiniMaxAdapterOptions = {},
): MiniMaxAdapter {
  return createMiniMaxAdapter({ ...config, model: config.model ?? MINIMAX_DEFAULT_MODEL }, options)
}

function profileOverrides(
  requestOptions: MiniMaxRequestOptions,
  overrides: MiniMaxAdapterOptions["profile"],
): Partial<ModelCapabilityProfile> {
  return {
    structuredOutput: false,
    supportsReasoningSummary: requestOptions.reasoningSplit,
    maxContextTokens: 512_000,
    ...overrides,
  }
}

function createMiniMaxFetch(options: MiniMaxAdapterOptions, requestOptions: MiniMaxRequestOptions): OpenAiFetch {
  const baseFetch = options.fetch ?? ((url, init) => pinnedFetch(url, {
    ...init,
    allowLocalDevelopment: options.allowLocalDevelopment === true,
  }))
  return async (url: string, init: OpenAiFetchInit) => {
    const body = buildMiniMaxRequestBody(init.body, requestOptions)
    const response = await baseFetch(url, { ...init, body })
    return requestOptions.reasoningSplit && response.ok ? normalizeMiniMaxReasoningResponse(response) : response
  }
}

export function assertMiniMaxConfiguration(config: MiniMaxConfig, model = config.model ?? MINIMAX_DEFAULT_MODEL): void {
  if (config.provider !== undefined && config.provider !== "minimax") throw new AgentModelError({
    code: "configuration_error", message: "MiniMax adapter provider must be minimax", provider: PROVIDER, model,
  })
  if (config.model !== undefined && !config.model.trim()) throw new AgentModelError({
    code: "configuration_error", message: "MiniMax model must not be empty", provider: PROVIDER, model,
  })
  if (config.baseUrl !== undefined && !config.baseUrl.trim()) throw new AgentModelError({
    code: "configuration_error", message: "MiniMax base URL must not be empty", provider: PROVIDER, model,
  })
}
