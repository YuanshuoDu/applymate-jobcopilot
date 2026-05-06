/**
 * ModelRouter — Unified AI provider abstraction
 *
 * Supports:
 *   • Anthropic (claude-*)            — native SDK
 *   • OpenAI (gpt-*)                  — OpenAI-compatible API
 *   • DeepSeek (deepseek-*)           — OpenAI-compatible
 *   • MiniMax (MiniMax-*, abab*)       — OpenAI-compatible
 *   • Qwen / 通义千问 (qwen-*)         — OpenAI-compatible (DashScope)
 *   • Zhipu / 智谱 (glm-*)            — OpenAI-compatible
 *   • Custom (any OpenAI-compatible)  — user-supplied base URL
 *
 * All non-Anthropic providers use the standard OpenAI Chat Completions format.
 */

import Anthropic from '@anthropic-ai/sdk'

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
    provider: 'anthropic', model: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5', description: '最快，适合批量打分',
    tier: 'fast', priceIn: 1, priceOut: 5, contextK: 200,
  },
  {
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6 ★', description: '默认推荐，质量与速度最均衡',
    tier: 'standard', priceIn: 3, priceOut: 15, contextK: 200,
  },
  {
    provider: 'anthropic', model: 'claude-opus-4-7',
    label: 'Claude Opus 4.7', description: '最强，适合复杂简历重构',
    tier: 'premium', priceIn: 5, priceOut: 25, contextK: 200,
  },

  // ── OpenAI ────────────────────────────────────────────────
  {
    provider: 'openai', model: 'gpt-4o-mini',
    label: 'GPT-4o Mini', description: '轻量快速，成本低',
    tier: 'fast', priceIn: 0.15, priceOut: 0.6, contextK: 128,
    defaultBase: 'https://api.openai.com/v1',
  },
  {
    provider: 'openai', model: 'gpt-4o',
    label: 'GPT-4o', description: '多模态，强推理',
    tier: 'standard', priceIn: 2.5, priceOut: 10, contextK: 128,
    defaultBase: 'https://api.openai.com/v1',
  },
  {
    provider: 'openai', model: 'gpt-4.1',
    label: 'GPT-4.1', description: '最新 OpenAI 旗舰',
    tier: 'premium', priceIn: 2, priceOut: 8, contextK: 128,
    defaultBase: 'https://api.openai.com/v1',
  },

  // ── DeepSeek ──────────────────────────────────────────────
  {
    provider: 'deepseek', model: 'deepseek-chat',
    label: 'DeepSeek V3 ★', description: '性价比极高，强烈推荐',
    tier: 'standard', priceIn: 0.27, priceOut: 1.1, contextK: 64,
    defaultBase: 'https://api.deepseek.com/v1',
  },
  {
    provider: 'deepseek', model: 'deepseek-reasoner',
    label: 'DeepSeek R1', description: '深度推理，适合复杂分析',
    tier: 'premium', priceIn: 0.55, priceOut: 2.19, contextK: 64,
    defaultBase: 'https://api.deepseek.com/v1',
  },

  // ── MiniMax ───────────────────────────────────────────────
  {
    provider: 'minimax', model: 'MiniMax-Text-01',
    label: 'MiniMax Text-01', description: '国产大模型，支持超长上下文',
    tier: 'standard', priceIn: 1, priceOut: 4, contextK: 1000,
    defaultBase: 'https://api.minimax.chat/v1',
  },
  {
    provider: 'minimax', model: 'abab6.5s-chat',
    label: 'MiniMax abab6.5s', description: '速度快，适合实时场景',
    tier: 'fast', priceIn: 0.3, priceOut: 0.3, contextK: 245,
    defaultBase: 'https://api.minimax.chat/v1',
  },

  // ── Qwen / 通义千问 ───────────────────────────────────────
  {
    provider: 'qwen', model: 'qwen-turbo-latest',
    label: 'Qwen Turbo', description: '速度快，成本低',
    tier: 'fast', priceIn: 0.04, priceOut: 0.12, contextK: 128,
    defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    provider: 'qwen', model: 'qwen-plus-latest',
    label: 'Qwen Plus ★', description: '综合能力强，价格合理',
    tier: 'standard', priceIn: 0.4, priceOut: 1.2, contextK: 128,
    defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    provider: 'qwen', model: 'qwen-max-latest',
    label: 'Qwen Max', description: '阿里旗舰，效果最佳',
    tier: 'premium', priceIn: 1.6, priceOut: 6.4, contextK: 32,
    defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },

  // ── Zhipu / 智谱 ─────────────────────────────────────────
  {
    provider: 'zhipu', model: 'glm-4-flash',
    label: 'GLM-4 Flash', description: '免费额度，速度快',
    tier: 'fast', priceIn: 0, priceOut: 0, contextK: 128,
    defaultBase: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    provider: 'zhipu', model: 'glm-4-plus',
    label: 'GLM-4 Plus', description: '综合能力提升版',
    tier: 'standard', priceIn: 0.7, priceOut: 0.7, contextK: 128,
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
  provider: 'anthropic',
  model:    'claude-sonnet-4-6',
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

export async function modelChat(
  messages:  ChatMessage[],
  config:    AiConfig,
  maxTokens: number = 1024,
): Promise<ChatResult> {
  const resolved = resolveConfig(config)

  if (!resolved.resolvedKey) {
    throw new Error(`No API key for provider "${resolved.provider}". Set it in Settings or add the server env var.`)
  }

  if (resolved.provider === 'anthropic') {
    return callAnthropic(messages, resolved, maxTokens)
  } else {
    return callOpenAICompat(messages, resolved, maxTokens)
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function callAnthropic(
  messages:  ChatMessage[],
  config:    AiConfig & { resolvedKey: string },
  maxTokens: number,
): Promise<ChatResult> {
  const client = new Anthropic({ apiKey: config.resolvedKey })

  // Separate system prompt from conversation
  const systemMsg = messages.find(m => m.role === 'system')
  const chatMsgs  = messages.filter(m => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[]

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

// ── OpenAI-compatible (DeepSeek / MiniMax / Qwen / Zhipu / OpenAI / Custom) ──

async function callOpenAICompat(
  messages:  ChatMessage[],
  config:    AiConfig & { resolvedKey: string; apiBase?: string },
  maxTokens: number,
): Promise<ChatResult> {
  const base = config.apiBase
  if (!base) throw new Error(`No API base URL for provider "${config.provider}"`)

  const resp = await fetch(`${base}/chat/completions`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.resolvedKey}`,
    },
    body: JSON.stringify({
      model:      config.model,
      max_tokens: maxTokens,
      messages,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`${config.provider} API error ${resp.status}: ${errText.slice(0, 200)}`)
  }

  const data = await resp.json()
  const text: string = data.choices?.[0]?.message?.content ?? ''
  return {
    text,
    inputTokens:  data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
    provider:     config.provider,
    model:        config.model,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip markdown code fences from AI JSON output */
export function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
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
  zhipu:     'Zhipu / 智谱',
  custom:    '自定义',
}
