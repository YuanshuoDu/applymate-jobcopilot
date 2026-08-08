export const MANAGED_FEATURES = {
  worker_discovery: { defaultEnabled: true },
  unattended_apply: { defaultEnabled: true },
} as const

export type ManagedFeatureKey = keyof typeof MANAGED_FEATURES
export type PlatformEnvironment = 'development' | 'staging' | 'production'

export type ManagedFeatureOverride = {
  enabled: boolean
  rolloutPercent: number
  targetPlans: readonly string[]
  targetUserIds: readonly string[]
  status: string
  rollbackAt: Date | string | null
}

export function isManagedFeatureKey(value: string): value is ManagedFeatureKey {
  return Object.hasOwn(MANAGED_FEATURES, value)
}

export function platformEnvironment(env: Record<string, string | undefined>): PlatformEnvironment {
  const configured = env.PLATFORM_ENV
  if (configured === 'development' || configured === 'staging' || configured === 'production') return configured
  return env.NODE_ENV === 'production' ? 'production' : 'development'
}

export function evaluateManagedFeature(key: ManagedFeatureKey, input: {
  environment: PlatformEnvironment
  userId: string
  plan: string | null
  flag: ManagedFeatureOverride | null
  now?: Date
}): boolean {
  const fallback = MANAGED_FEATURES[key].defaultEnabled
  const flag = input.flag
  const now = input.now ?? new Date()
  if (!flag || flag.status !== 'active' || isExpired(flag.rollbackAt, now)) return fallback
  if (!flag.enabled) return false
  if (flag.targetUserIds.includes(input.userId)) return true
  if (flag.targetPlans.length > 0 && (!input.plan || !flag.targetPlans.includes(input.plan))) return false
  if (flag.rolloutPercent <= 0) return false
  if (flag.rolloutPercent >= 100) return true
  return rolloutBucket(`${key}:${input.environment}:${input.userId}`) < flag.rolloutPercent
}

function isExpired(value: Date | string | null, now: Date): boolean {
  if (!value) return false
  const date = value instanceof Date ? value : new Date(value)
  return !Number.isNaN(date.getTime()) && date <= now
}

function rolloutBucket(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  }
  return (hash >>> 0) % 100
}
