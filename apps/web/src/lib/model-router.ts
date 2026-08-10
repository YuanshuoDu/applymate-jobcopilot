/**
 * ModelRouter — Unified AI provider abstraction
 *
 * Supports:
 *   • Anthropic (claude-*)   — native SDK
 *   • OpenAI (gpt-*)         — OpenAI-compatible API
 *   • DeepSeek (deepseek-*)  — OpenAI-compatible
 *   • MiniMax (MiniMax-*)    — OpenAI-compatible
 *   • Qwen (qwen*)           — OpenAI-compatible (DashScope)
 *   • Z.ai / Zhipu (glm-*)   — OpenAI-compatible
 *   • Kimi (kimi-*)           — OpenAI-compatible (Moonshot)
 *   • Custom                 — user-supplied base URL
 */

import Anthropic from '@anthropic-ai/sdk'
import { db }    from '@/lib/db'
import { isSafeAiEndpoint } from '@jobcopilot/shared/safe-ai-endpoint'
import { recordAiUsage } from '@/lib/ai-usage'

// ── Provider & model catalogue ────────────────────────────────────────────────

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'minimax'
  | 'qwen'
  | 'zhipu'
  | 'kimi'
  | 'custom'

export interface ModelOption {
  provider:    Provider
  model:       string
  label:       string
  description: string
  tier:        'fast' | 'standard' | 'premium'
  priceIn:     number   // USD per 1M input tokens
  priceOut:    number   // USD per 1M output tokens
  contextK:    number   // context window in K tokens
  defaultBase?: string  // default API base URL
}

export const MODEL_CATALOGUE: ModelOption[] = [
  // ── Anthropic ──────────────────────────────────────────────
  {
    provider: 'anthropic', model: 'claude-sonnet-5',
    label: 'Claude Sonnet 5', description: '当前速度与能力的均衡选择',
    tier: 'premium', priceIn: 3, priceOut: 15, contextK: 1000,
  },
  {
    provider: 'anthropic', model: 'claude-fable-5',
    label: 'Claude Fable 5', description: '当前最高能力，适合长程复杂任务',
    tier: 'premium', priceIn: 10, priceOut: 50, contextK: 1000,
  },

  // ── OpenAI ────────────────────────────────────────────────
  {
    provider: 'openai', model: 'gpt-5.5',
    label: 'GPT-5.5', description: '稳定可用的旗舰选择',
    tier: 'premium', priceIn: 5, priceOut: 30, contextK: 1000,
    defaultBase: 'https://api.openai.com/v1',
  },
  {
    provider: 'openai', model: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol', description: '最新前沿能力，复杂推理与编码',
    tier: 'premium', priceIn: 5, priceOut: 30, contextK: 1050,
    defaultBase: 'https://api.openai.com/v1',
  },
  {
    provider: 'openai', model: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra', description: '当前旗舰的能力与成本平衡款',
    tier: 'premium', priceIn: 2.5, priceOut: 15, contextK: 1050,
    defaultBase: 'https://api.openai.com/v1',
  },
  {
    provider: 'openai', model: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna', description: '面向高吞吐和成本敏感任务',
    tier: 'standard', priceIn: 1, priceOut: 6, contextK: 1050,
    defaultBase: 'https://api.openai.com/v1',
  },

  // ── DeepSeek ──────────────────────────────────────────────
  {
    provider: 'deepseek', model: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro', description: '当前旗舰推理，1M 上下文',
    tier: 'standard', priceIn: 0.435, priceOut: 0.87, contextK: 1000,
    defaultBase: 'https://api.deepseek.com/v1',
  },
  {
    provider: 'deepseek', model: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash', description: '当前低延迟版本，1M 上下文',
    tier: 'fast', priceIn: 0.14, priceOut: 0.28, contextK: 1000,
    defaultBase: 'https://api.deepseek.com/v1',
  },

  // ── MiniMax ───────────────────────────────────────────────
  {
    provider: 'minimax', model: 'MiniMax-M3',
    label: 'MiniMax M3', description: '平台默认，当前文本旗舰',
    tier: 'standard', priceIn: 0.6, priceOut: 2.4, contextK: 512,
    defaultBase: 'https://api.minimax.chat/v1',
  },
  {
    provider: 'minimax', model: 'MiniMax-M2.7-highspeed',
    label: 'MiniMax M2.7 Highspeed', description: '同等能力的低延迟版本',
    tier: 'fast', priceIn: 0.6, priceOut: 2.4, contextK: 200,
    defaultBase: 'https://api.minimax.chat/v1',
  },

  // ── Qwen / 通义千问 ───────────────────────────────────────
  {
    provider: 'qwen', model: 'qwen3.7-plus',
    label: 'Qwen3.7 Plus', description: '当前均衡款，支持工具调用与 1M 上下文',
    tier: 'standard', priceIn: 0.28, priceOut: 1.12, contextK: 1000,
    defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    provider: 'qwen', model: 'qwen3.7-flash',
    label: 'Qwen3.7 Flash', description: '当前快速经济款，适合高频任务',
    tier: 'fast', priceIn: 0, priceOut: 0, contextK: 1000,
    defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },

  // ── Z.ai / 智谱 ───────────────────────────────────────────
  {
    provider: 'zhipu', model: 'glm-5.1',
    label: 'GLM-5.1', description: '当前长程 Agent 旗舰，200K 上下文',
    tier: 'standard', priceIn: 1.05, priceOut: 3.5, contextK: 200,
    defaultBase: 'https://api.z.ai/api/paas/v4',
  },
  {
    provider: 'zhipu', model: 'glm-5-turbo',
    label: 'GLM-5 Turbo', description: 'GLM 5 当前高速 Agent 版本',
    tier: 'fast', priceIn: 0, priceOut: 0, contextK: 200,
    defaultBase: 'https://api.z.ai/api/paas/v4',
  },

  // ── Kimi / Moonshot ───────────────────────────────────────
  {
    provider: 'kimi', model: 'kimi-k2.5',
    label: 'Kimi K2.5', description: '当前多模态 Kimi 模型，适合复杂中文与 Agent 任务',
    tier: 'premium', priceIn: 0, priceOut: 0, contextK: 256,
    defaultBase: 'https://api.moonshot.ai/v1',
  },

  // ── Custom ────────────────────────────────────────────────
  {
    provider: 'custom', model: 'custom',
    label: '自定义模型', description: '任何 OpenAI 兼容端点',
    tier: 'standard', priceIn: 0, priceOut: 0, contextK: 128,
  },
]

// ── User AI config (stored in preferences JSON) ───────────────────────────────

export interface AiConfig {
  provider:   Provider
  model:      string
  apiKey?:    string   // user's own key; falls back to server env var
  apiBase?:   string   // override base URL (required for custom)
  thinking?:  MiniMaxThinkingMode
}

export type MiniMaxThinkingMode = 'adaptive' | 'disabled'

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'minimax',
  model:    'MiniMax-M3',
}

/** Apply a MiniMax M3 thinking policy without changing another provider or model. */
export function withMiniMaxThinking(config: AiConfig, thinking: MiniMaxThinkingMode): AiConfig {
  return config.provider === 'minimax' && config.model === 'MiniMax-M3'
    ? { ...config, thinking }
    : config
}

// ── Resolve effective config ──────────────────────────────────────────────────

/** Merge user config with server env-var fallbacks */
export function resolveConfig(userConfig?: AiConfig | null): AiConfig & { resolvedKey: string } {
  const input  = userConfig ?? DEFAULT_AI_CONFIG
  const exact  = MODEL_CATALOGUE.find(m => m.provider === input.provider && m.model === input.model)
  const option = exact
    ?? MODEL_CATALOGUE.find(m => m.provider === input.provider)
    ?? MODEL_CATALOGUE.find(m => m.provider === 'minimax' && m.model === 'MiniMax-M3')
    ?? MODEL_CATALOGUE[0]

  // Saved settings can outlive a provider model. Do not send a retired model
  // identifier to the provider; retain custom model IDs because they are user-owned.
  const cfg = !exact && input.provider !== 'custom'
    ? { ...input, provider: option.provider, model: option.model }
    : input

  // API key: user's key > server env var
  const resolvedKey = cfg.apiKey?.trim()
    || getServerKey(cfg.provider)
    || ''

  // Only custom providers own their endpoint. Internal providers must retain
  // their curated base so a persisted override cannot receive a platform key.
  const resolvedBase = cfg.provider === 'custom'
    ? cfg.apiBase?.trim() || option?.defaultBase || ''
    : option?.defaultBase || ''

  return { ...cfg, apiBase: resolvedBase, resolvedKey }
}

function getServerKey(provider: Provider): string {
  switch (provider) {
    case 'anthropic': return process.env.ANTHROPIC_API_KEY ?? ''
    case 'openai':    return process.env.OPENAI_API_KEY    ?? ''
    case 'deepseek':  return process.env.DEEPSEEK_API_KEY  ?? ''
    case 'minimax':   return process.env.MINIMAX_API_KEY   ?? ''
    case 'qwen':      return process.env.QWEN_API_KEY      ?? ''
    case 'zhipu':     return process.env.ZHIPU_API_KEY     ?? ''
    case 'kimi':      return process.env.KIMI_API_KEY      ?? ''
    // A custom endpoint is user-controlled, so it must never receive a
    // server-level credential. Custom configs require a saved user key.
    case 'custom':    return ''
    default:          return ''
  }
}

// ── Core chat function ────────────────────────────────────────────────────────

export interface ChatMessage {
  role:    'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  text:         string
  inputTokens?: number
  outputTokens?: number
  provider:     Provider
  model:        string
}

function assertKey(resolved: AiConfig & { resolvedKey: string }) {
  if (!resolved.resolvedKey) {
    const isApplyMate = resolved.provider === APPLYMATE_BACKING.provider
      && resolved.model === APPLYMATE_BACKING.model
    throw new Error(isApplyMate
      ? `${APPLYMATE_LABEL} 默认模型当前不可用，请在 Settings → AI 模型 中配置自己的 API Key`
      : `No API key for provider "${resolved.provider}". Set it in Settings or add the server env var.`
    )
  }
}

export async function modelChat(
  messages:  ChatMessage[],
  config:    AiConfig,
  maxTokens: number = 1024,
  usageContext?: { userId?: string; featureKey?: string },
): Promise<ChatResult> {
  const resolved = resolveConfig(config)
  const startedAt = Date.now()
  try {
    assertKey(resolved)
    const result = resolved.provider === 'anthropic'
      ? await callAnthropic(messages, resolved, maxTokens)
      : await callOpenAICompat(messages, resolved, maxTokens)
    void recordAiUsage({ ...usageContext, provider: result.provider, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedCostUsd: aiCost(result.provider, result.model, result.inputTokens ?? 0, result.outputTokens ?? 0), latencyMs: Date.now() - startedAt, status: 'success' })
    return result
  } catch (error) {
    void recordAiUsage({ ...usageContext, provider: resolved.provider, model: resolved.model, estimatedCostUsd: 0, latencyMs: Date.now() - startedAt, status: 'error', errorCode: error instanceof Error ? error.message.slice(0, 120) : 'unknown_error' })
    throw error
  }
}

function aiCost(provider: Provider, model: string, inputTokens: number, outputTokens: number): number {
  const option = MODEL_CATALOGUE.find(item => item.provider === provider && item.model === model)
  return option ? Number(((inputTokens / 1_000_000) * option.priceIn + (outputTokens / 1_000_000) * option.priceOut).toFixed(8)) : 0
}

/**
 * Streaming chat — yields text deltas one by one.
 * <think>…</think> reasoning blocks (MiniMax / DeepSeek R1) are filtered out.
 */
export async function* modelChatStream(
  messages:  ChatMessage[],
  config:    AiConfig,
  maxTokens: number = 1024,
): AsyncGenerator<string> {
  const resolved = resolveConfig(config)
  assertKey(resolved)

  const raw = resolved.provider === 'anthropic'
    ? streamAnthropic(messages, resolved, maxTokens)
    : streamOpenAICompat(messages, resolved, maxTokens)

  yield* stripThinkStream(raw)
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

function splitSystemMessages(messages: ChatMessage[]) {
  const systemMsg = messages.find(m => m.role === 'system')
  const chatMsgs  = messages.filter(m => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[]
  return { systemMsg, chatMsgs }
}

async function callAnthropic(
  messages:  ChatMessage[],
  config:    AiConfig & { resolvedKey: string },
  maxTokens: number,
): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: config.resolvedKey })
  const { systemMsg, chatMsgs } = splitSystemMessages(messages)

  const resp = await client.messages.create({
    model:      config.model,
    max_tokens: maxTokens,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages:   chatMsgs,
  })

  const text = resp.content[0].type === 'text' ? resp.content[0].text : ''
  return {
    text,
    inputTokens:  resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    provider:     'anthropic',
    model:        config.model,
  }
}

async function* streamAnthropic(
  messages:  ChatMessage[],
  config:    AiConfig & { resolvedKey: string },
  maxTokens: number,
): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey: config.resolvedKey })
  const { systemMsg, chatMsgs } = splitSystemMessages(messages)

  const stream = await client.messages.create({
    model:      config.model,
    max_tokens: maxTokens,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages:   chatMsgs,
    stream:     true,
  })

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      yield chunk.delta.text
    }
  }
}

// ── OpenAI-compatible (DeepSeek / MiniMax / Qwen / Z.ai / Kimi / OpenAI / Custom) ──

interface OaiRequestConfig {
  base:      string
  provider:  Provider
  model:     string
  key:       string
  messages:  ChatMessage[]
  maxTokens: number
  stream:    boolean
  thinking?: MiniMaxThinkingMode
}

function oaiFetch(c: OaiRequestConfig): Promise<Response> {
  if (c.provider === 'custom' && !isSafeAiEndpoint(c.base, { allowLocalDevelopment: process.env.NODE_ENV !== 'production' })) {
    return Promise.reject(new Error('Custom AI endpoint is not an allowed public HTTPS destination'))
  }
  const controller = new AbortController()
  // Audits compare two full documents and can legitimately take longer than a
  // short suggestion request. Keep a bounded timeout, but avoid aborting a
  // valid independent-audit response halfway through generation.
  const timer = setTimeout(() => controller.abort(), 120_000)
  // MiniMax models use a provider-specific completion field. M3 also lets us
  // choose adaptive reasoning (quality) or disable it for short, bounded work.
  const providerOptions = c.provider === 'minimax'
    ? {
        max_completion_tokens: c.maxTokens,
        reasoning_split: true,
        ...(c.model === 'MiniMax-M3' ? { thinking: { type: c.thinking ?? 'adaptive' } } : {}),
      }
    : { max_tokens: c.maxTokens }
  return fetch(`${c.base}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${c.key}` },
    body:    JSON.stringify({ model: c.model, ...providerOptions, messages: c.messages, stream: c.stream }),
    redirect: 'error',
    signal:  controller.signal,
  }).finally(() => clearTimeout(timer))
}

async function oaiCheck(resp: Response, provider: Provider): Promise<void> {
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`${provider} API error ${resp.status}: ${errText.slice(0, 200)}`)
  }
}

async function callOpenAICompat(
  messages:  ChatMessage[],
  config:    AiConfig & { resolvedKey: string; apiBase?: string },
  maxTokens: number,
): Promise<ChatResult> {
  if (!config.apiBase) throw new Error(`No API base URL for provider "${config.provider}"`)
  const resp = await oaiFetch({ base: config.apiBase, provider: config.provider, model: config.model, key: config.resolvedKey, messages, maxTokens, stream: false, thinking: config.thinking })
  await oaiCheck(resp, config.provider)
  const data: unknown = await resp.json()
  const response = data as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  const choice = response.choices?.[0]
  const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
  if (!text.trim()) {
    const finish = choice?.finish_reason ? ` (finish reason: ${choice.finish_reason})` : ''
    throw new Error(`${config.provider} returned no final content${finish}`)
  }
  return { text, inputTokens: response.usage?.prompt_tokens, outputTokens: response.usage?.completion_tokens, provider: config.provider, model: config.model }
}

async function* streamOpenAICompat(
  messages:  ChatMessage[],
  config:    AiConfig & { resolvedKey: string; apiBase?: string },
  maxTokens: number,
): AsyncGenerator<string> {
  if (!config.apiBase) throw new Error(`No API base URL for provider "${config.provider}"`)
  const resp = await oaiFetch({ base: config.apiBase, provider: config.provider, model: config.model, key: config.resolvedKey, messages, maxTokens, stream: true, thinking: config.thinking })
  await oaiCheck(resp, config.provider)

  const reader  = resp.body!.getReader()
  const decoder = new TextDecoder()
  let lineBuf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lineBuf += decoder.decode(value, { stream: true })
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') return
        try {
          const json = JSON.parse(payload)
          const delta = json.choices?.[0]?.delta?.content
          if (delta) yield delta
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally { reader.releaseLock() }
}

// ── Think-block filter (MiniMax / DeepSeek R1 reasoning tokens) ───────────────

async function* stripThinkStream(source: AsyncGenerator<string>): AsyncGenerator<string> {
  let buf     = ''
  let inThink = false

  for await (const chunk of source) {
    buf += chunk

    while (true) {
      if (!inThink) {
        const idx = buf.indexOf('<think>')
        if (idx === -1) {
          // Safe to yield everything except last 7 chars (partial "<think>" guard)
          const safe = Math.max(0, buf.length - 7)
          if (safe > 0) { yield buf.slice(0, safe); buf = buf.slice(safe) }
          break
        }
        if (idx > 0) yield buf.slice(0, idx)
        buf     = buf.slice(idx + 7)
        inThink = true
      } else {
        const idx = buf.indexOf('</think>')
        if (idx === -1) {
          // Discard, keep tail for partial-tag detection
          buf = buf.length > 8 ? buf.slice(buf.length - 8) : buf
          break
        }
        buf     = buf.slice(idx + 8)
        inThink = false
      }
    }
  }

  if (!inThink && buf) yield buf
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip markdown code fences and reasoning blocks from AI JSON output. */
export function stripFences(raw: string): string {
  let clean = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*/gi, '')
    .trim()

  // Extract first JSON object/array from within the text
  if (!clean.startsWith('{') && !clean.startsWith('[')) {
    const objMatch = clean.match(/\{[\s\S]*\}/)
    if (objMatch) return objMatch[0]
    const arrMatch = clean.match(/\[[\s\S]*\]/)
    if (arrMatch) return arrMatch[0]
  }
  return clean
}

/**
 * Parse an AI response that is expected to be JSON.
 * Handles: code fences, <think> blocks, surrounding text, and nested extraction.
 * Throws if no valid JSON can be found.
 */
export function parseAiJson<T = unknown>(raw: string): T {
  const text = stripFences(raw)
  // 1. Direct parse
  try { return JSON.parse(text) as T } catch { /* fall through */ }
  // 2. Regex-extract first JSON object
  const objM = text.match(/\{[\s\S]*\}/)
  if (objM) { try { return JSON.parse(objM[0]) as T } catch { /* fall through */ } }
  // 3. Regex-extract first JSON array
  const arrM = text.match(/\[[\s\S]*\]/)
  if (arrM) { try { return JSON.parse(arrM[0]) as T } catch { /* fall through */ } }
  throw new Error(`AI response could not be parsed as JSON. Raw: ${text.slice(0, 120)}`)
}

/** Group catalogue by provider for UI rendering */
export function catalogueByProvider(): Record<Provider, ModelOption[]> {
  const result = {} as Record<Provider, ModelOption[]>
  for (const m of MODEL_CATALOGUE) {
    if (!result[m.provider]) result[m.provider] = []
    result[m.provider].push(m)
  }
  return result
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai:    'OpenAI',
  deepseek:  'DeepSeek',
  minimax:   'MiniMax',
  qwen:      'Qwen / 通义千问',
  zhipu:     'Z.ai / 智谱',
  kimi:      'Kimi / Moonshot',
  custom:    '自定义',
}

// ── ApplyMate (built-in default, no user key required) ───────────────────────

/** Display name for the built-in default model shown in the UI */
export const APPLYMATE_LABEL = 'ApplyMate'

/** The real config behind the "ApplyMate" virtual model */
export const APPLYMATE_BACKING: AiConfig = {
  provider: 'minimax',
  model:    'MiniMax-M3',
  thinking: 'adaptive',
}

// ── Per-feature AI settings ───────────────────────────────────────────────────

export type FeatureId =
  | 'scoring'
  | 'parsing'
  | 'suggest'
  | 'coverLetter'
  | 'agent'
  | 'fieldSuggest'
  | 'interviewPrep'
  | 'formFill'
  | 'formRevise'
  | 'autoApply'
  | 'jobScoring'

export const FEATURE_LABELS: Record<FeatureId, string> = {
  scoring:       '简历评分 / 岗位匹配',
  parsing:       '简历上传解析',
  suggest:       'AI 改进建议',
  coverLetter:   '求职信生成',
  agent:         'AI Agent',
  fieldSuggest:  'AI 字段建议',
  interviewPrep: '面试准备',
  formFill:      '表单自动填写',
  formRevise:    '表单填写修改',
  autoApply:     '自动申请 Agent（无人值守）',
  jobScoring:    '职位评分 + 关键词提取',
}

/**
 * Per-user AI settings stored in User.preferences.aiSettings
 *
 * features[featureId] = null  →  use ApplyMate AI (MiniMax M3, server key)
 * features[featureId] = AiConfig  →  use that specific model
 * keys[provider] = string  →  user-supplied API key for that provider
 */
export interface UserAiSettings {
  features?: Partial<Record<FeatureId, AiConfig | null>>
  keys?:     Partial<Record<Provider, string>>
}

/**
 * Resolve the effective AiConfig for a specific feature.
 * Priority: feature override → ApplyMate AI default
 * API key priority: feature.apiKey → keys[provider] → server env var
 */
/** Load user's AI config for a feature (auth + rate limit handled by caller). DRY helper for all AI routes. */
export async function loadUserAiConfig(
  userId:    string,
  featureId: FeatureId,
): Promise<AiConfig & { resolvedKey: string }> {
  const user   = await db.user.findUnique({ where: { id: userId }, select: { preferences: true } })
  const prefs  = (user?.preferences ?? {}) as Record<string, unknown>
  return resolveFeatureConfig(featureId, (prefs.aiSettings ?? null) as UserAiSettings | null)
}

export function resolveFeatureConfig(
  featureId: FeatureId,
  settings: UserAiSettings | null | undefined,
): AiConfig & { resolvedKey: string } {
  const featureCfg = settings?.features?.[featureId] ?? null
  const baseCfg    = featureCfg ?? APPLYMATE_BACKING

  // Merge per-provider key if feature config doesn't have its own
  const providerKey = settings?.keys?.[baseCfg.provider]
  const merged: AiConfig = {
    ...baseCfg,
    apiKey: baseCfg.apiKey?.trim() || providerKey?.trim() || undefined,
  }

  return resolveConfig(merged)
}
