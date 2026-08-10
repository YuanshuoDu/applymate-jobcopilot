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
  { provider: 'anthropic', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', description: '当前速度与能力的均衡选择', tier: 'premium', priceIn: 3, priceOut: 15, contextK: 1000 },
  { provider: 'anthropic', model: 'claude-fable-5', label: 'Claude Fable 5', description: '当前最高能力，适合长程复杂任务', tier: 'premium', priceIn: 10, priceOut: 50, contextK: 1000 },
  { provider: 'openai', model: 'gpt-5.5', label: 'GPT-5.5', description: '稳定可用的旗舰选择', tier: 'premium', priceIn: 5, priceOut: 30, contextK: 1000, defaultBase: 'https://api.openai.com/v1' },
  { provider: 'openai', model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: '最新前沿能力，复杂推理与编码', tier: 'premium', priceIn: 5, priceOut: 30, contextK: 1050, defaultBase: 'https://api.openai.com/v1' },
  { provider: 'openai', model: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: '当前旗舰的能力与成本平衡款', tier: 'premium', priceIn: 2.5, priceOut: 15, contextK: 1050, defaultBase: 'https://api.openai.com/v1' },
  { provider: 'openai', model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: '面向高吞吐和成本敏感任务', tier: 'standard', priceIn: 1, priceOut: 6, contextK: 1050, defaultBase: 'https://api.openai.com/v1' },
  { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: '当前旗舰推理，1M 上下文', tier: 'standard', priceIn: 0.435, priceOut: 0.87, contextK: 1000, defaultBase: 'https://api.deepseek.com/v1' },
  { provider: 'deepseek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: '当前低延迟版本，1M 上下文', tier: 'fast', priceIn: 0.14, priceOut: 0.28, contextK: 1000, defaultBase: 'https://api.deepseek.com/v1' },
  { provider: 'minimax', model: 'MiniMax-M3', label: 'MiniMax M3', description: '平台默认，当前文本旗舰', tier: 'standard', priceIn: 0.6, priceOut: 2.4, contextK: 512, defaultBase: 'https://api.minimax.chat/v1' },
  { provider: 'minimax', model: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', description: '同等能力的低延迟版本', tier: 'fast', priceIn: 0.6, priceOut: 2.4, contextK: 200, defaultBase: 'https://api.minimax.chat/v1' },
  { provider: 'qwen', model: 'qwen3.7-plus', label: 'Qwen3.7 Plus', description: '当前均衡款，支持工具调用与 1M 上下文', tier: 'standard', priceIn: 0.28, priceOut: 1.12, contextK: 1000, defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider: 'qwen', model: 'qwen3.7-flash', label: 'Qwen3.7 Flash', description: '当前快速经济款，适合高频任务', tier: 'fast', priceIn: 0, priceOut: 0, contextK: 1000, defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider: 'zhipu', model: 'glm-5.1', label: 'GLM-5.1', description: '当前长程 Agent 旗舰，200K 上下文', tier: 'standard', priceIn: 1.05, priceOut: 3.5, contextK: 200, defaultBase: 'https://api.z.ai/api/paas/v4' },
  { provider: 'zhipu', model: 'glm-5-turbo', label: 'GLM-5 Turbo', description: 'GLM 5 当前高速 Agent 版本', tier: 'fast', priceIn: 0, priceOut: 0, contextK: 200, defaultBase: 'https://api.z.ai/api/paas/v4' },
  { provider: 'kimi', model: 'kimi-k2.5', label: 'Kimi K2.5', description: '当前多模态 Kimi 模型，适合复杂中文与 Agent 任务', tier: 'premium', priceIn: 0, priceOut: 0, contextK: 256, defaultBase: 'https://api.moonshot.ai/v1' },
  { provider: 'custom', model: 'custom', label: '自定义模型', description: '任何 OpenAI 兼容端点', tier: 'standard', priceIn: 0, priceOut: 0, contextK: 128 },
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
  scoring: '简历评分 / 岗位匹配',
  parsing: '简历上传解析',
  suggest: 'AI 改进建议',
  coverLetter: '求职信生成',
  agent: 'AI Agent',
  fieldSuggest: 'AI 字段建议',
  interviewPrep: '面试准备',
  formFill: '表单自动填写',
  formRevise: '表单填写修改',
  autoApply: '自动申请 Agent（无人值守）',
  jobScoring: '职位评分 + 关键词提取',
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
  qwen: 'Qwen / 通义千问',
  zhipu: 'Z.ai / 智谱',
  kimi: 'Kimi / Moonshot',
  custom: '自定义',
}
