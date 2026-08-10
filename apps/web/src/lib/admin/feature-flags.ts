import type { Plan } from '@prisma/client'
import { isManagedFeatureKey, type ManagedFeatureKey } from '@jobcopilot/shared'

const environments = ['development', 'staging', 'production'] as const
const plans = ['free', 'pro', 'enterprise'] as const

export type FeatureFlagInput = {
  key: ManagedFeatureKey
  environment: (typeof environments)[number]
  enabled: boolean
  rolloutPercent: number
  targetPlans: Plan[]
  targetUserIds: string[]
  rollbackAt: Date | null
}

function isHighRiskKey(key: string) {
  return /(?:auto|unattended)[_-]?apply|captcha|payment|auth(?:entication)?|source[_-]?compliance/i.test(key)
}

export function parseFeatureFlag(value: unknown): FeatureFlagInput | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  const environment = typeof record.environment === 'string' && environments.includes(record.environment as FeatureFlagInput['environment']) ? record.environment as FeatureFlagInput['environment'] : null
  const rolloutPercent = typeof record.rolloutPercent === 'number' && Number.isInteger(record.rolloutPercent) ? record.rolloutPercent : -1
  const targetPlans = Array.isArray(record.targetPlans) ? [...new Set(record.targetPlans.filter((plan): plan is Plan => typeof plan === 'string' && plans.includes(plan as Plan)))] : []
  const targetUserIds = Array.isArray(record.targetUserIds) ? [...new Set(record.targetUserIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64))] : []
  const rollbackAt = typeof record.rollbackAt === 'string' && !Number.isNaN(Date.parse(record.rollbackAt)) ? new Date(record.rollbackAt) : null
  if (!isManagedFeatureKey(key) || !environment || typeof record.enabled !== 'boolean' || rolloutPercent < 0 || rolloutPercent > 100 || targetUserIds.length > 1_000) return null
  if (environment === 'production' && isHighRiskKey(key) && (!rollbackAt || rollbackAt <= new Date())) return null
  return { key, environment, enabled: record.enabled, rolloutPercent, targetPlans, targetUserIds, rollbackAt }
}
