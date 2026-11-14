import { resolveMiniMaxBaseUrl } from '@jobcopilot/shared/minimax'
import { db } from '@/lib/db'
import { decryptAiSettings } from '@/lib/ai-credential-settings'
import { APPLYMATE_BACKING, DEFAULT_AI_CONFIG, MODEL_CATALOGUE, type AiConfig, type FeatureId, type Provider, type UserAiSettings } from './model-router-catalogue'

/** Merge user config with server environment fallbacks. */
export function resolveConfig(userConfig?: AiConfig | null, options?: { preserveModel?: boolean }): AiConfig & { resolvedKey: string; credentialSource: 'platform' | 'user' } {
  const input = userConfig ?? DEFAULT_AI_CONFIG
  const exact = MODEL_CATALOGUE.find(model => model.provider === input.provider && model.model === input.model)
  const option = exact ?? MODEL_CATALOGUE.find(model => model.provider === input.provider)
    ?? MODEL_CATALOGUE.find(model => model.provider === 'minimax' && model.model === 'MiniMax-M3') ?? MODEL_CATALOGUE[0]
  const config = !exact && input.provider !== 'custom' && !options?.preserveModel
    ? { ...input, provider: option.provider, model: option.model } : input
  const resolvedKey = config.apiKey?.trim() || getServerKey(config.provider) || ''
  const resolvedBase = config.provider === 'custom' ? config.apiBase?.trim() || option?.defaultBase || ''
    : config.provider === 'minimax' ? resolveMiniMaxBaseUrl({ baseUrl: option?.defaultBase, apiKey: resolvedKey,
      environmentBaseUrl: process.env.MINIMAX_BASE_URL, environmentRegion: process.env.MINIMAX_REGION }) : option?.defaultBase || ''
  const credentialSource = config.credentialSource ?? (config.apiKey?.trim() ? 'user' : 'platform')
  return { ...config, apiBase: resolvedBase, resolvedKey, credentialSource }
}

function getServerKey(provider: Provider): string {
  switch (provider) {
    case 'anthropic': return process.env.ANTHROPIC_API_KEY ?? ''
    case 'openai': return process.env.OPENAI_API_KEY ?? ''
    case 'deepseek': return process.env.DEEPSEEK_API_KEY ?? ''
    case 'minimax': return process.env.MINIMAX_API_KEY ?? ''
    case 'qwen': return process.env.QWEN_API_KEY ?? ''
    case 'zhipu': return process.env.ZHIPU_API_KEY ?? ''
    case 'kimi': return process.env.KIMI_API_KEY ?? ''
    case 'custom': return ''
    default: return ''
  }
}

export async function loadUserAiConfig(userId: string, featureId: FeatureId): Promise<AiConfig & { resolvedKey: string }> {
  const settings = await loadUserAiSettings(userId)
  return { ...resolveFeatureConfig(featureId, settings), usageUserId: userId, usageFeatureKey: featureId, usageRuntime: 'web' }
}

export async function loadUserAiSettings(userId: string): Promise<UserAiSettings> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { preferences: true } })
  const preferences = (user?.preferences ?? {}) as Record<string, unknown>
  const settings = await decryptAiSettings(preferences.aiSettings ?? null, userId)
  return settings as UserAiSettings
}

export function resolveFeatureConfig(featureId: FeatureId, settings: UserAiSettings | null | undefined): AiConfig & { resolvedKey: string } {
  const featureConfig = settings?.features?.[featureId] ?? null
  const baseConfig = featureConfig ?? APPLYMATE_BACKING
  const providerKey = settings?.keys?.[baseConfig.provider]
  return resolveConfig({ ...baseConfig, apiKey: baseConfig.apiKey?.trim() || providerKey?.trim() || undefined })
}
