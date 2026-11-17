import { isSafeAiEndpoint } from '@jobcopilot/shared/safe-ai-endpoint'
import { aiUsageErrorCode, recordAiUsage } from '@/lib/ai-usage'
import { resolveConfig, loadUserAiConfig, loadUserAiSettings, resolveFeatureConfig } from './model-router-config'
import { APPLYMATE_BACKING, APPLYMATE_LABEL, MODEL_CATALOGUE, type AiConfig, type ChatMessage, type ChatResult,
  type Provider } from './model-router-catalogue'
import { callAnthropic, callOpenAICompat, callReservedOpenAICompat, streamAnthropic, streamOpenAICompat,
  stripThinkStream, type StreamUsage } from './model-router-transport'

export { APPLYMATE_BACKING, APPLYMATE_LABEL, DEFAULT_AI_CONFIG, FEATURE_LABELS, MODEL_CATALOGUE, PROVIDER_LABELS,
  catalogueByProvider, withMiniMaxThinking } from './model-router-catalogue'
export type { AiConfig, ChatMessage, ChatResult, FeatureId, MiniMaxThinkingMode, ModelOption, Provider, UserAiSettings } from './model-router-catalogue'
export { loadUserAiConfig, loadUserAiSettings, resolveConfig, resolveFeatureConfig }

export interface ReservedModelTransport {
  provider: Provider
  model: string
  credentialSource: 'platform' | 'user'
  chat(messages: ChatMessage[], maxTokens: number, signal?: AbortSignal): Promise<ChatResult>
}

function assertKey(resolved: AiConfig & { resolvedKey: string }) {
  if (!resolved.resolvedKey) {
    const isApplyMate = resolved.provider === APPLYMATE_BACKING.provider && resolved.model === APPLYMATE_BACKING.model
    throw new Error(isApplyMate
      ? `${APPLYMATE_LABEL} Default model is currently unavailable, please Settings → AI Model Configure your own in API Key`
      : `No API key for provider "${resolved.provider}". Set it in Settings or add the server env var.`)
  }
}

export async function modelChat(messages: ChatMessage[], config: AiConfig, maxTokens = 1024,
  usageContext?: { userId?: string; featureKey?: string; runtime?: AiConfig['usageRuntime']; chargeBudget?: boolean }): Promise<ChatResult> {
  const resolved = resolveConfig(config)
  const effectiveUsage = usageContext ?? { userId: config.usageUserId, featureKey: config.usageFeatureKey, runtime: config.usageRuntime }
  const startedAt = Date.now()
  try {
    assertKey(resolved)
    const result = resolved.provider === 'anthropic' ? await callAnthropic(messages, resolved, maxTokens)
      : await callOpenAICompat(messages, resolved, maxTokens)
    await recordAiUsage({ ...effectiveUsage, credentialSource: resolved.credentialSource, provider: result.provider, model: result.model,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      estimatedCostUsd: aiCost(result.provider, result.model, result.inputTokens ?? 0, result.outputTokens ?? 0),
      latencyMs: Date.now() - startedAt, status: 'success' })
    return result
  } catch (error: unknown) {
    await recordAiUsage({ ...effectiveUsage, credentialSource: resolved.credentialSource, provider: resolved.provider, model: resolved.model,
      estimatedCostUsd: 0, latencyMs: Date.now() - startedAt, status: 'error', errorCode: aiUsageErrorCode(error) })
    throw error
  }
}

export function estimateAiCostUsd(provider: Provider, model: string, inputTokens: number, outputTokens: number): number | null {
  const option = MODEL_CATALOGUE.find(item => item.provider === provider && item.model === model)
  if (!option || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return null
  return Number(((inputTokens / 1_000_000) * option.priceIn + (outputTokens / 1_000_000) * option.priceOut).toFixed(8))
}

function aiCost(provider: Provider, model: string, inputTokens: number, outputTokens: number): number {
  return estimateAiCostUsd(provider, model, inputTokens, outputTokens) ?? 0
}

/** Provider transport for calls whose usage is reserved and settled by a caller-owned broker. */
export function prepareReservedModelTransport(config: AiConfig): ReservedModelTransport {
  const resolved = resolveConfig(config)
  assertKey(resolved)
  if (resolved.provider === 'custom' && !isSafeAiEndpoint(resolved.apiBase ?? '', {
    allowLocalDevelopment: process.env.NODE_ENV !== 'production' })) {
    throw new Error('Custom AI endpoint is not an allowed public HTTPS destination')
  }
  if (resolved.provider !== 'anthropic' && !resolved.apiBase) throw new Error(`No API base URL for provider "${resolved.provider}"`)
  return { provider: resolved.provider, model: resolved.model, credentialSource: resolved.credentialSource,
    chat: async (messages, maxTokens, signal) => {
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('model_output_limit_invalid')
      if (signal?.aborted) throw signal.reason ?? abortError()
      return resolved.provider === 'anthropic' ? callAnthropic(messages, resolved, maxTokens, { signal, maxRetries: 0 })
        : callReservedOpenAICompat(messages, resolved, maxTokens, signal)
    } }
}

function abortError(): Error { const error = new Error('The operation was aborted'); error.name = 'AbortError'; return error }

export async function* modelChatStream(messages: ChatMessage[], config: AiConfig, maxTokens = 1024,
  usageContext?: { userId?: string; featureKey?: string; runtime?: AiConfig['usageRuntime'] }): AsyncGenerator<string> {
  const resolved = resolveConfig(config)
  const effectiveUsage = usageContext ?? { userId: config.usageUserId, featureKey: config.usageFeatureKey, runtime: config.usageRuntime }
  const startedAt = Date.now(), streamUsage: StreamUsage = {}
  let started = false, recorded = false
  try {
    assertKey(resolved)
    const raw = resolved.provider === 'anthropic' ? streamAnthropic(messages, resolved, maxTokens, streamUsage)
      : streamOpenAICompat(messages, resolved, maxTokens, streamUsage)
    started = true
    yield* stripThinkStream(raw)
    recorded = true
    await recordAiUsage({ ...effectiveUsage, credentialSource: resolved.credentialSource, provider: resolved.provider, model: resolved.model,
      inputTokens: streamUsage.inputTokens, outputTokens: streamUsage.outputTokens,
      estimatedCostUsd: aiCost(resolved.provider, resolved.model, streamUsage.inputTokens ?? 0, streamUsage.outputTokens ?? 0),
      latencyMs: Date.now() - startedAt, status: 'success' })
  } catch (error: unknown) {
    if (!recorded) {
      recorded = true
      await recordAiUsage({ ...effectiveUsage, credentialSource: resolved.credentialSource, provider: resolved.provider, model: resolved.model,
        inputTokens: streamUsage.inputTokens, outputTokens: streamUsage.outputTokens,
        latencyMs: Date.now() - startedAt, status: 'error', errorCode: aiUsageErrorCode(error) })
    }
    throw error
  } finally {
    if (started && !recorded) {
      try {
        await recordAiUsage({ ...effectiveUsage, credentialSource: resolved.credentialSource, provider: resolved.provider, model: resolved.model,
          inputTokens: streamUsage.inputTokens, outputTokens: streamUsage.outputTokens,
          latencyMs: Date.now() - startedAt, status: 'error', chargeBudget: false })
      } catch { /* Telemetry must not prevent a consumer from closing the stream. */ }
    }
  }
}

export function stripFences(raw: string): string {
  let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?\s*/gi, '').trim()
  if (!clean.startsWith('{') && !clean.startsWith('[')) {
    const object = clean.match(/\{[\s\S]*\}/)
    if (object) return object[0]
    const array = clean.match(/\[[\s\S]*\]/)
    if (array) return array[0]
  }
  return clean
}

export function parseAiJson<T = unknown>(raw: string): T {
  const text = stripFences(raw)
  try { return JSON.parse(text) as T } catch { /* try extracting a JSON value */ }
  const object = text.match(/\{[\s\S]*\}/)
  if (object) { try { return JSON.parse(object[0]) as T } catch { /* try an array */ } }
  const array = text.match(/\[[\s\S]*\]/)
  if (array) { try { return JSON.parse(array[0]) as T } catch { /* report the parse failure */ } }
  throw new Error(`AI response could not be parsed as JSON. Raw: ${text.slice(0, 120)}`)
}
