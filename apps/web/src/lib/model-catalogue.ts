/**
 * AI model catalogue — client-safe (no Node.js SDK imports).
 * Imported by both client components (SettingsPage) and server routes.
 */

export type Provider =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'minimax'
  | 'qwen'
  | 'zhipu'
  | 'custom'

export interface ModelOption {
  provider:     Provider
  model:        string
  label:        string
  description:  string
  tier:         'fast' | 'standard' | 'premium'
  priceIn:      number
  priceOut:     number
  contextK:     number
  defaultBase?: string
}

export interface AiConfig {
  provider:  Provider
  model:     string
  apiKey?:   string
  apiBase?:  string
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'anthropic',
  model:    'claude-sonnet-4-6',
}

export const MODEL_CATALOGUE: ModelOption[] = [
  // ── Anthropic ──────────────────────────────────────────────
  { provider:'anthropic', model:'claude-haiku-4-5',  label:'Claude Haiku 4.5',   description:'最快，适合批量打分',           tier:'fast',     priceIn:1,    priceOut:5,    contextK:200 },
  { provider:'anthropic', model:'claude-sonnet-4-6', label:'Claude Sonnet 4.6 ★',description:'默认推荐，质量与速度最均衡',   tier:'standard', priceIn:3,    priceOut:15,   contextK:200 },
  { provider:'anthropic', model:'claude-opus-4-7',   label:'Claude Opus 4.7',    description:'最强，适合复杂简历重构',       tier:'premium',  priceIn:5,    priceOut:25,   contextK:200 },
  // ── OpenAI ────────────────────────────────────────────────
  { provider:'openai', model:'gpt-4o-mini', label:'GPT-4o Mini', description:'轻量快速，成本低',      tier:'fast',     priceIn:0.15, priceOut:0.6,  contextK:128, defaultBase:'https://api.openai.com/v1' },
  { provider:'openai', model:'gpt-4o',      label:'GPT-4o',      description:'多模态，强推理',        tier:'standard', priceIn:2.5,  priceOut:10,   contextK:128, defaultBase:'https://api.openai.com/v1' },
  { provider:'openai', model:'gpt-4.1',     label:'GPT-4.1',     description:'最新 OpenAI 旗舰',     tier:'premium',  priceIn:2,    priceOut:8,    contextK:128, defaultBase:'https://api.openai.com/v1' },
  // ── DeepSeek ──────────────────────────────────────────────
  { provider:'deepseek', model:'deepseek-chat',     label:'DeepSeek V3 ★',  description:'性价比极高，强烈推荐',   tier:'standard', priceIn:0.27, priceOut:1.1,  contextK:64, defaultBase:'https://api.deepseek.com/v1' },
  { provider:'deepseek', model:'deepseek-reasoner', label:'DeepSeek R1',    description:'深度推理，适合复杂分析', tier:'premium',  priceIn:0.55, priceOut:2.19, contextK:64, defaultBase:'https://api.deepseek.com/v1' },
  // ── MiniMax ───────────────────────────────────────────────
  { provider:'minimax', model:'MiniMax-Text-01', label:'MiniMax Text-01', description:'国产大模型，支持超长上下文', tier:'standard', priceIn:1,   priceOut:4,   contextK:1000, defaultBase:'https://api.minimax.chat/v1' },
  { provider:'minimax', model:'abab6.5s-chat',   label:'MiniMax abab6.5s',description:'速度快，适合实时场景',     tier:'fast',     priceIn:0.3, priceOut:0.3, contextK:245,  defaultBase:'https://api.minimax.chat/v1' },
  // ── Qwen ─────────────────────────────────────────────────
  { provider:'qwen', model:'qwen-turbo-latest', label:'Qwen Turbo',   description:'速度快，成本低',          tier:'fast',     priceIn:0.04, priceOut:0.12, contextK:128, defaultBase:'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider:'qwen', model:'qwen-plus-latest',  label:'Qwen Plus ★',  description:'综合能力强，价格合理',    tier:'standard', priceIn:0.4,  priceOut:1.2,  contextK:128, defaultBase:'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider:'qwen', model:'qwen-max-latest',   label:'Qwen Max',     description:'阿里旗舰，效果最佳',      tier:'premium',  priceIn:1.6,  priceOut:6.4,  contextK:32,  defaultBase:'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  // ── Zhipu ────────────────────────────────────────────────
  { provider:'zhipu', model:'glm-4-flash', label:'GLM-4 Flash', description:'免费额度，速度快',      tier:'fast',     priceIn:0,   priceOut:0,   contextK:128, defaultBase:'https://open.bigmodel.cn/api/paas/v4' },
  { provider:'zhipu', model:'glm-4-plus',  label:'GLM-4 Plus',  description:'综合能力提升版',        tier:'standard', priceIn:0.7, priceOut:0.7, contextK:128, defaultBase:'https://open.bigmodel.cn/api/paas/v4' },
  // ── Custom ────────────────────────────────────────────────
  { provider:'custom', model:'custom', label:'自定义模型', description:'任何 OpenAI 兼容端点', tier:'standard', priceIn:0, priceOut:0, contextK:128 },
]

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai:    'OpenAI',
  deepseek:  'DeepSeek',
  minimax:   'MiniMax',
  qwen:      'Qwen / 通义千问',
  zhipu:     'Zhipu / 智谱',
  custom:    '自定义',
}
