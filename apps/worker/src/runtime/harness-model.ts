import {
  AgentModelError,
  executeWithModelFallback,
  ModelAdapterRegistry,
  type HarnessModelRequest,
  type ModelAdapter,
  type ModelStreamEvent,
  type ModelUsage,
  type ModelRouteCandidate,
  type ModelSelectionEvent,
} from "@jobcopilot/agent-model"
import { createAnthropicAdapter } from "@jobcopilot/agent-model/adapters/anthropic"
import { createMiniMaxM3Adapter, type MiniMaxAdapterOptions } from "@jobcopilot/agent-model/adapters/minimax"
import { createOpenAiCompatibleAdapter, type OpenAiCompatibleAdapterOptions } from "@jobcopilot/agent-model/adapters/openai-compatible"
import { estimateSharedAiCost } from "@jobcopilot/shared"
import { APPLYMATE_BACKING, type AiConfig, type Provider } from "@jobcopilot/shared/llm"

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5"
const DEFAULT_OPENAI_MODEL = "gpt-5.5"
const OPENAI_COMPATIBLE_BASE_URLS: Partial<Record<Provider, string>> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://api.z.ai/api/paas/v4",
  kimi: "https://api.moonshot.ai/v1",
}

export type HarnessFetch = (url: string, init: {
  method: "POST"
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}) => Promise<Response>

export type HarnessModelRuntimeOptions = {
  primary?: AiConfig
  fallbacks?: readonly AiConfig[]
  fetch?: HarnessFetch
  allowLocalDevelopment?: boolean
  maxReroutes?: number
  irreversibleActionStarted?: boolean | (() => boolean)
  onSelectionEvent?: (event: ModelSelectionEvent) => void
}

export type HarnessModelRuntime = {
  adapter: ModelAdapter
  registry: ModelAdapterRegistry
  candidates: readonly ModelRouteCandidate[]
}

/** Build the executable model path used by TurnEngine. MiniMax M3 is the default route. */
export function createHarnessModelRuntime(options: HarnessModelRuntimeOptions = {}): HarnessModelRuntime {
  const configs = uniqueConfigs([
    options.primary ?? APPLYMATE_BACKING,
    ...(options.fallbacks ?? []),
    ...environmentFallbacks(),
  ]).filter(hasCredential)
  if (configs.length === 0) throw new AgentModelError({
    code: "configuration_error",
    message: "No Harness model route has an API key configured",
    recoverable: false,
  })

  const registry = new ModelAdapterRegistry()
  const candidates: ModelRouteCandidate[] = []
  const credentialSources = new Map<string, "platform" | "user">()
  for (const [index, config] of configs.entries()) {
    const adapter = createAdapter(config, options)
    registry.register(adapter)
    credentialSources.set(`${adapter.profile.provider}:${adapter.profile.model}`, credential(config))
    candidates.push({
      target: { provider: adapter.profile.provider, model: adapter.profile.model },
      requirement: { nativeTools: true, streaming: true },
      reason: index === 0 ? "Harness default route" : "Configured Harness fallback route",
    })
  }

  const primary = registry.resolve(candidates[0].target, candidates[0].requirement)
  const adapter: ModelAdapter = {
    id: `harness-router:${primary.profile.provider}:${primary.profile.model}`,
    profile: primary.profile,
    stream: (request) => routeStream(request, registry, candidates, credentialSources, options),
  }
  return { adapter, registry, candidates }
}

async function* routeStream(
  request: HarnessModelRequest,
  registry: ModelAdapterRegistry,
  candidates: readonly ModelRouteCandidate[],
  credentialSources: ReadonlyMap<string, "platform" | "user">,
  options: HarnessModelRuntimeOptions,
): AsyncIterable<ModelStreamEvent> {
  const result = await executeWithModelFallback(registry, candidates, async (candidate, attempt) => {
    const events: ModelStreamEvent[] = []
    for await (const event of candidate.stream(requestForAdapter(request, candidate))) events.push(event)
    const normalized = normalizeUsage(events, candidate, credentialSources)
    return { value: normalized, usage: usage(normalized) }
  }, {
    maxReroutes: options.maxReroutes,
    irreversibleActionStarted: options.irreversibleActionStarted,
    onEvent: options.onSelectionEvent,
  })
  yield* result.value
}

function createAdapter(config: AiConfig, options: HarnessModelRuntimeOptions): ModelAdapter {
  const fetchOptions = options.fetch ? { fetch: options.fetch } : {}
  const common = { allowLocalDevelopment: options.allowLocalDevelopment }
  if (config.provider === "minimax") {
    const adapterOptions: MiniMaxAdapterOptions = { ...common, ...fetchOptions }
    return createMiniMaxM3Adapter({
      provider: "minimax", model: config.model, thinking: config.thinking,
      apiBase: config.apiBase, ...(credential(config) === "user" ? { apiKey: config.apiKey } : { platformApiKey: config.apiKey }),
    }, adapterOptions)
  }
  if (config.provider === "anthropic") {
    return createAnthropicAdapter({
      provider: "anthropic", model: config.model, baseUrl: config.apiBase, apiKey: config.apiKey ?? environmentKey(config.provider) ?? "",
    }, { ...common, ...fetchOptions })
  }
  const baseUrl = config.apiBase ?? OPENAI_COMPATIBLE_BASE_URLS[config.provider]
  if (!baseUrl) throw new AgentModelError({
    code: "configuration_error", message: `Provider ${config.provider} requires apiBase for Harness`, provider: config.provider, model: config.model,
  })
  const adapterOptions: OpenAiCompatibleAdapterOptions = { ...common, ...fetchOptions }
  return createOpenAiCompatibleAdapter({
    provider: config.provider, model: config.model, baseUrl, apiKey: config.apiKey ?? environmentKey(config.provider) ?? "",
  }, adapterOptions)
}

function requestForAdapter(request: HarnessModelRequest, adapter: ModelAdapter): HarnessModelRequest {
  const { continuation: _continuation, ...withoutContinuation } = request
  return {
    ...withoutContinuation,
    provider: adapter.profile.provider,
    model: adapter.profile.model,
    capabilities: {
      nativeTools: adapter.profile.nativeTools,
      structuredOutput: adapter.profile.structuredOutput,
      streaming: adapter.profile.streaming,
      continuationCursor: adapter.profile.continuationCursor,
    },
    ...(adapter.profile.continuationCursor && request.continuation ? { continuation: request.continuation } : {}),
  }
}

function normalizeUsage(events: readonly ModelStreamEvent[], adapter: ModelAdapter, credentialSources: ReadonlyMap<string, "platform" | "user">): ModelStreamEvent[] {
  const source = credentialSources.get(`${adapter.profile.provider}:${adapter.profile.model}`) ?? "platform"
  return events.map((event) => {
    if (event.type !== "usage") return event
    return {
      ...event,
      provider: adapter.profile.provider,
      model: adapter.profile.model,
      ...(event.estimatedCostUsd !== undefined ? {} : {
        estimatedCostUsd: estimateSharedAiCost({ provider: adapter.profile.provider, model: adapter.profile.model, credentialSource: source, inputTokens: event.inputTokens, outputTokens: event.outputTokens, latencyMs: 0, status: "success" }),
      }),
    }
  })
}

function usage(events: readonly ModelStreamEvent[]): ModelUsage | null {
  const event = [...events].reverse().find((candidate): candidate is Extract<ModelStreamEvent, { type: "usage" }> => candidate.type === "usage")
  return event ? { inputTokens: event.inputTokens, outputTokens: event.outputTokens, estimatedCostUsd: event.estimatedCostUsd ?? 0 } : null
}

function uniqueConfigs(configs: readonly AiConfig[]): AiConfig[] {
  const seen = new Set<string>()
  return configs.filter((config) => {
    const key = `${config.provider}:${config.model}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hasCredential(config: AiConfig): boolean {
  return Boolean(config.apiKey?.trim() || environmentKey(config.provider))
}

function credential(config: AiConfig): "platform" | "user" {
  return config.credentialSource ?? (config.apiKey ? "user" : "platform")
}

function environmentFallbacks(): AiConfig[] {
  const fallbacks: AiConfig[] = []
  if (environmentKey("anthropic")) fallbacks.push({ provider: "anthropic", model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL })
  if (environmentKey("openai")) fallbacks.push({ provider: "openai", model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL })
  return fallbacks
}

function environmentKey(provider: Provider): string | undefined {
  const key = {
    minimax: process.env.MINIMAX_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    qwen: process.env.QWEN_API_KEY,
    zhipu: process.env.ZHIPU_API_KEY,
    kimi: process.env.KIMI_API_KEY,
    custom: undefined,
  }[provider]
  return key?.trim() || undefined
}
