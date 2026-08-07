import type { AiConfig, UserAiSettings } from '@/lib/model-router'

/** Return a user-facing validation message for a custom OpenAI-compatible config. */
export function customConfigError(config: AiConfig | null | undefined): string | null {
  if (!config || config.provider !== 'custom') return null
  if (!config.model?.trim()) return 'Custom provider requires a model ID'
  if (!config.apiBase?.trim()) return 'Custom provider requires an HTTPS endpoint'

  try {
    const endpoint = new URL(config.apiBase)
    if (endpoint.protocol !== 'https:') return 'Custom provider endpoint must use HTTPS'
    if (endpoint.username || endpoint.password || endpoint.hash) return 'Custom provider endpoint cannot contain credentials or a fragment'
  } catch {
    return 'Custom provider endpoint must be a valid HTTPS URL'
  }
  return null
}

export function hasIncompleteCustomConfig(features: UserAiSettings['features'] | undefined): boolean {
  return Object.values(features ?? {}).some(config => config?.provider === 'custom' && customConfigError(config) !== null)
}
