import {
  discoveryApiKeyStatusFromSaved,
  type DiscoveryApiKeyStatus,
  type DiscoverySavedKeys,
} from '@/lib/discovery-api-keys'
import type { Provider, UserAiSettings } from '@/lib/model-router'
import { PRIVACY_CAPABILITIES } from '@/lib/privacy-consent'

const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'deepseek', 'minimax', 'qwen', 'zhipu', 'kimi', 'custom']
const PLATFORM_KEY_ENV: Partial<Record<Provider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  qwen: 'QWEN_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  kimi: 'KIMI_API_KEY',
}

export type UserIntegrationStatus = {
  accounts: { gmail: boolean; github: boolean }
  ai: {
    providers: Record<Provider, { userConfigured: boolean; platformConfigured: boolean; effective: boolean }>
    featureOverrides: number
    customConfigured: boolean
  }
  discovery: DiscoveryApiKeyStatus
}

export type PlatformIntegrationStatus = {
  ai: { providers: Record<Provider, boolean> }
  discovery: { adzuna: boolean; rapidapi: boolean }
  oauth: { google: boolean; github: boolean }
  messaging: { resend: boolean }
  infrastructure: { database: boolean; redis: boolean }
  privacy: typeof PRIVACY_CAPABILITIES
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function platformProviderStatus(): Record<Provider, boolean> {
  return Object.fromEntries(PROVIDERS.map(provider => [
    provider,
    hasValue(PLATFORM_KEY_ENV[provider] ? process.env[PLATFORM_KEY_ENV[provider]!] : undefined),
  ])) as Record<Provider, boolean>
}

export function userIntegrationStatus(input: {
  preferences?: unknown
  apiKeys?: DiscoverySavedKeys
  accounts?: Array<{ provider?: unknown; scope?: unknown }>
  accountProviders?: string[]
}): UserIntegrationStatus {
  const preferences = asRecord(input.preferences)
  const aiSettings = asRecord(preferences.aiSettings) as unknown as UserAiSettings
  const userKeys = asRecord(aiSettings.keys)
  const features = asRecord(aiSettings.features)
  const platform = platformProviderStatus()
  const accounts = input.accounts ?? (input.accountProviders ?? []).map(provider => ({ provider, scope: undefined }))
  const providers = Object.fromEntries(PROVIDERS.map(provider => {
    const featureConfigured = Object.values(features).some(value => {
      const feature = asRecord(value)
      return feature.provider === provider && hasValue(feature.apiKey)
    })
    const userConfigured = hasValue(userKeys[provider]) || featureConfigured
    const platformConfigured = platform[provider]
    return [provider, { userConfigured, platformConfigured, effective: userConfigured || platformConfigured }]
  })) as UserIntegrationStatus['ai']['providers']

  return {
    accounts: {
      gmail: accounts.some(account => account.provider === 'gmail'
        || (account.provider === 'google' && typeof account.scope === 'string' && account.scope.includes('gmail'))),
      github: accounts.some(account => account.provider === 'github'),
    },
    ai: {
      providers,
      featureOverrides: Object.values(features).filter(value => value !== null && typeof value === 'object').length,
      customConfigured: Object.values(features).some(value => asRecord(value).provider === 'custom'),
    },
    discovery: discoveryApiKeyStatusFromSaved(input.apiKeys ?? null),
  }
}

export function platformIntegrationStatus(): PlatformIntegrationStatus {
  return {
    ai: { providers: platformProviderStatus() },
    discovery: {
      adzuna: hasValue(process.env.ADZUNA_APP_ID) && hasValue(process.env.ADZUNA_APP_KEY),
      rapidapi: hasValue(process.env.RAPIDAPI_KEY),
    },
    oauth: {
      google: hasValue(process.env.AUTH_GOOGLE_ID) && hasValue(process.env.AUTH_GOOGLE_SECRET),
      github: hasValue(process.env.AUTH_GITHUB_ID) && hasValue(process.env.AUTH_GITHUB_SECRET),
    },
    messaging: { resend: hasValue(process.env.RESEND_API_KEY) },
    infrastructure: {
      database: hasValue(process.env.DATABASE_URL),
      redis: hasValue(process.env.REDIS_URL),
    },
    privacy: PRIVACY_CAPABILITIES,
  }
}
