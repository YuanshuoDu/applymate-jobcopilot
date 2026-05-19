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
 *   • Custom                 — user-supplied base URL
 */

import Anthropic from '@anthropic-ai/sdk'
import { db }    from '@/lib/db'

// ── Provider & model catalogue ────────────────────────────────────────────────

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'minimax'
  | 'qwen'
  | 'zhipu'
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
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6 ★', description: '质量与速度最均衡',
    tier: 'standard', priceIn: 3, priceOut: 15, contextK: 200,
  },
  {
    provider: 'anthropic', model: 'claude-opus-4-7',
    label: 'Claude Opus 4.7', description: '最强推理，适合复杂任务',
    tier: 'premium', priceIn: 5, priceOut: 25, contextK: 200,
  },

  // ── OpenAI ────────────────────────────────────────────────
  {
    provider: 'openai', model: 'gpt-5.5',
    label: 'GPT-5.5 ★', description: '最新旗舰，1M 上下文，强编程推理',
    tier: 'premium', priceIn: 5, priceOut: 30, contextK: 1050,
    defaultBase: 'https://api.openai.com/v1',
  },
  {
    provider: 'openai', model: 'gpt-5',
    label: 'GPT-5 ★', description: '旗舰性价比，比 5.5 便宜 4x',
    tier: 'standard', priceIn: 1.25, priceOut: 10, contextK: 200,
    defaultBase: 'https://api.openai.com/v1',
  },
  {
    provider: 'openai', model: 'gpt-5-mini',
    label: 'GPT-5 Mini', description: '轻量快速，日常任务首选',
    tier: 'fast', priceIn: 0.25, priceOut: 2, contextK: 200,
    defaultBase: 'https://api.openai.com/v1',
  },

  // ── DeepSeek ──────────────────────────────────────────────
  {
    provider: 'deepseek', model: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro ★', description: '旗舰推理，1M 上下文，性价比极高',
    tier: 'standard', priceIn: 0.27, priceOut: 1.1, contextK: 1000,
    defaultBase: 'https://api.deepseek.com/v1',
  },
  {
    provider: 'deepseek', model: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash', description: '极速版，1M 上下文，低延迟',
    tier: 'fast', priceIn: 0.07, priceOut: 0.28, contextK: 1000,
    defaultBase: 'https://api.deepseek.com/v1',
  },

  // ── MiniMax ───────────────────────────────────────────────
  {
    provider: 'minimax', model: 'MiniMax-M2.7',
    label: 'MiniMax M2.7 ★', description: '平台默认，强推理，200K 上下文',
    tier: 'standard', priceIn: 0.3, priceOut: 1.2, contextK: 200,
    defaultBase: 'https://api.minimax.chat/v1',
  },

  // ── Qwen / 通义千问 ───────────────────────────────────────
  {
    provider: 'qwen', model: 'qwen3-max',
    label: 'Qwen3 Max ★', description: '阿里旗舰，256K 上下文，强推理',
    tier: 'standard', priceIn: 0.78, priceOut: 3.9, contextK: 256,
    defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    provider: 'qwen', model: 'qwen3.6-plus',
    label: 'Qwen3.6 Plus', description: '新一代，面向 Agent 场景',
    tier: 'fast', priceIn: 0.33, priceOut: 1.95, contextK: 128,
    defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },

  // ── Z.ai / 智谱 ───────────────────────────────────────────
  {
    provider: 'zhipu', model: 'glm-5.1',
    label: 'GLM-5.1 ★', description: 'SWE-Bench 全球第一，200K 上下文',
    tier: 'standard', priceIn: 1.05, priceOut: 3.5, contextK: 200,
    defaultBase: 'https://open.bigmodel.cn/api/paas/v4',
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
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'minimax',
  model:    'MiniMax-M2.7',
}

// ── Resolve effective config ──────────────────────────────────────────────────

/** Merge user config with server env-var fallbacks */
export function resolveConfig(userConfig?: AiConfig | null): AiConfig & { resolvedKey: string } {
  const cfg    = userConfig ?? DEFAULT_AI_CONFIG
  const option = MODEL_CATALOGUE.find(m => m.provider === cfg.provider && m.model === cfg.model)
    ?? MODEL_CATALOGUE.find(m => m.provider === cfg.provider)
    ?? MODEL_CATALOGUE[1]  // fallback to Sonnet

  // API key: user's key > server env var
  const resolvedKey = cfg.apiKey?.trim()
    || getServerKey(cfg.provider)
    || ''

  const resolvedBase = cfg.apiBase?.trim() || option?.defaultBase || ''

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
    case 'custom':    return process.env.CUSTOM_API_KEY    ?? ''
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
): Promise<ChatResult> {
  const resolved = resolveConfig(config)
  assertKey(resolved)

  if (resolved.provider === 'anthropic') {
    return callAnthropic(messages, resolved, maxTokens)
  } else {
    return callOpenAICompat(messages, resolved, maxTokens)
  }
}

/**
 * Streaming chat — yields text deltas one by one.
 * <think>…</think> reasoning blocks (MiniMax M2.7 / DeepSeek R1) are filtered out.
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

// ── OpenAI-compatible (DeepSeek / MiniMax / Qwen / Zhipu / OpenAI / Custom) ──

interface OaiRequestConfig {
  base:      string
  provider:  Provider
  model:     string
  key:       string
  messages:  ChatMessage[]
  maxTokens: number
  stream:    boolean
}

function oaiFetch(c: OaiRequestConfig): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  return fetch(`${c.base}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${c.key}` },
    body:    JSON.stringify({ model: c.model, max_tokens: c.maxTokens, messages: c.messages, stream: c.stream }),
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
  const resp = await oaiFetch({ base: config.apiBase, provider: config.provider, model: config.model, key: config.resolvedKey, messages, maxTokens, stream: false })
  await oaiCheck(resp, config.provider)
  const data = await resp.json()
  const text: string = data.choices?.[0]?.message?.content ?? ''
  return { text, inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, provider: config.provider, model: config.model }
}

async function* streamOpenAICompat(
  messages:  ChatMessage[],
  config:    AiConfig & { resolvedKey: string; apiBase?: string },
  maxTokens: number,
): AsyncGenerator<string> {
  if (!config.apiBase) throw new Error(`No API base URL for provider "${config.provider}"`)
  const resp = await oaiFetch({ base: config.apiBase, provider: config.provider, model: config.model, key: config.resolvedKey, messages, maxTokens, stream: true })
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

// ── Think-block filter (MiniMax M2.7 / DeepSeek R1 reasoning tokens) ──────────

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
  custom:    '自定义',
}

// ── ApplyMate (built-in default, no user key required) ───────────────────────

/** Display name for the built-in default model shown in the UI */
export const APPLYMATE_LABEL = 'ApplyMate'

/** The real config behind the "ApplyMate" virtual model */
export const APPLYMATE_BACKING: AiConfig = {
  provider: 'minimax',
  model:    'MiniMax-M2.7',
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
}

/**
 * Per-user AI settings stored in User.preferences.aiSettings
 *
 * features[featureId] = null  →  use ApplyMate AI (MiniMax M2.7, server key)
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
