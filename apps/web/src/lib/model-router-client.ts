/**
 * Browser-safe AI catalogue and settings types.
 *
 * Keep this module free of database, Node.js, and server-only network imports.
 * Settings and Agent pages use these values in client components, while the
 * actual model calls stay in model-router.ts and API routes.
 */

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
  provider: Provider
  model: string
  label: string
  description: string
  tier: 'fast' | 'standard' | 'premium'
  priceIn: number
  priceOut: number
  contextK: number
  defaultBase?: string
}

export const MODEL_CATALOGUE: ModelOption[] = [
  { provider: 'anthropic', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Balanced choice of current speed and ability', tier: 'premium', priceIn: 3, priceOut: 15, contextK: 1000 },
  { provider: 'anthropic', model: 'claude-fable-5', label: 'Claude Fable 5', description: 'Current highest ability, Suitable for long-range and complex tasks', tier: 'premium', priceIn: 10, priceOut: 50, contextK: 1000 },
  { provider: 'openai', model: 'gpt-5.5', label: 'GPT-5.5', description: 'A stable and usable flagship choice', tier: 'premium', priceIn: 5, priceOut: 30, contextK: 1000, defaultBase: 'https://api.openai.com/v1' },
  { provider: 'openai', model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Latest cutting-edge capabilities, Complex reasoning and coding', tier: 'premium', priceIn: 5, priceOut: 30, contextK: 1050, defaultBase: 'https://api.openai.com/v1' },
  { provider: 'openai', model: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Current flagship’s capabilities and cost balance', tier: 'premium', priceIn: 2.5, priceOut: 15, contextK: 1050, defaultBase: 'https://api.openai.com/v1' },
  { provider: 'openai', model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'For high-throughput and cost-sensitive tasks', tier: 'standard', priceIn: 1, priceOut: 6, contextK: 1050, defaultBase: 'https://api.openai.com/v1' },
  { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Current flagship reasoning, 1M context', tier: 'standard', priceIn: 0.435, priceOut: 0.87, contextK: 1000, defaultBase: 'https://api.deepseek.com/v1' },
  { provider: 'deepseek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Current low latency version, 1M context', tier: 'fast', priceIn: 0.14, priceOut: 0.28, contextK: 1000, defaultBase: 'https://api.deepseek.com/v1' },
  { provider: 'minimax', model: 'MiniMax-M3', label: 'MiniMax M3', description: 'Platform default, current text flagship', tier: 'standard', priceIn: 0.6, priceOut: 2.4, contextK: 512, defaultBase: 'https://api.minimax.io/v1' },
  { provider: 'minimax', model: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', description: 'A low-latency version with the same capabilities', tier: 'fast', priceIn: 0.6, priceOut: 2.4, contextK: 200, defaultBase: 'https://api.minimax.io/v1' },
  { provider: 'qwen', model: 'qwen3.7-plus', label: 'Qwen3.7 Plus', description: 'Current balance, Support tool calls and 1M context', tier: 'standard', priceIn: 0.28, priceOut: 1.12, contextK: 1000, defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider: 'qwen', model: 'qwen3.7-flash', label: 'Qwen3.7 Flash', description: 'Current fast and economical model, Suitable for high-frequency tasks', tier: 'fast', priceIn: 0, priceOut: 0, contextK: 1000, defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider: 'zhipu', model: 'glm-5.1', label: 'GLM-5.1', description: 'Current long distance Agent flagship, 200K context', tier: 'standard', priceIn: 1.05, priceOut: 3.5, contextK: 200, defaultBase: 'https://api.z.ai/api/paas/v4' },
  { provider: 'zhipu', model: 'glm-5-turbo', label: 'GLM-5 Turbo', description: 'GLM 5 Current highway Agent Version', tier: 'fast', priceIn: 0, priceOut: 0, contextK: 200, defaultBase: 'https://api.z.ai/api/paas/v4' },
  { provider: 'kimi', model: 'kimi-k2.5', label: 'Kimi K2.5', description: 'Current multimodal Kimi model for complex multilingual and agent tasks', tier: 'premium', priceIn: 0, priceOut: 0, contextK: 256, defaultBase: 'https://api.moonshot.ai/v1' },
  { provider: 'custom', model: 'custom', label: 'custom model', description: 'any OpenAI Compatible endpoints', tier: 'standard', priceIn: 0, priceOut: 0, contextK: 128 },
]

export interface AiConfig {
  provider: Provider
  model: string
  apiKey?: string
  apiBase?: string
  thinking?: MiniMaxThinkingMode
}

export type MiniMaxThinkingMode = 'adaptive' | 'disabled'

export const APPLYMATE_LABEL = 'ApplyMate'
export const APPLYMATE_BACKING: AiConfig = {
  provider: 'minimax',
  model: 'MiniMax-M3',
  thinking: 'adaptive',
}

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
  scoring: 'Resume scoring / Job matching',
  parsing: 'Resume upload analysis',
  suggest: 'AI Improvement suggestions',
  coverLetter: 'Cover letter generation',
  agent: 'AI Agent',
  fieldSuggest: 'AI Field suggestions',
  interviewPrep: 'Interview preparation',
  formFill: 'Form autofill',
  formRevise: 'Form filling and modification',
  autoApply: 'Automatic application Agent(unattended)',
  jobScoring: 'job rating + Keyword extraction',
}

export interface UserAiSettings {
  features?: Partial<Record<FeatureId, AiConfig | null>>
  keys?: Partial<Record<Provider, string>>
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  qwen: 'Qwen / Tongyi Qianwen',
  zhipu: 'Z.ai / Wisdom spectrum',
  kimi: 'Kimi / Moonshot',
  custom: 'Customize',
}
