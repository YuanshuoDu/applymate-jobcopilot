import { Plan, UserAccountStatus } from '@prisma/client'

export function reasonFrom(value: unknown, label: string): string | { error: string } {
  if (typeof value !== 'string') return { error: `${label} is required` }
  const reason = value.trim()
  return reason.length >= 10 && reason.length <= 500
    ? reason
    : { error: `${label} must be between 10 and 500 characters` }
}

export function parseAccountState(value: unknown): UserAccountStatus | null {
  return value === UserAccountStatus.active || value === UserAccountStatus.suspended
    ? value
    : null
}

export function parsePlan(value: unknown): Plan | null {
  return value === Plan.free || value === Plan.pro || value === Plan.enterprise ? value : null
}

export type FeatureOverrideInput = {
  featureKey: string
  enabled: boolean
  limit: number | null
  expiresAt: Date | null
}

export function parseFeatureOverride(value: unknown): FeatureOverrideInput | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Invalid feature override' }
  const input = value as Record<string, unknown>
  const featureKey = typeof input.featureKey === 'string' ? input.featureKey.trim() : ''
  if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(featureKey)) return { error: 'featureKey is invalid' }
  if (typeof input.enabled !== 'boolean') return { error: 'enabled must be boolean' }

  let limit: number | null = null
  if (input.limit !== null && input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 0 || input.limit > 1_000_000) {
      return { error: 'limit must be an integer between 0 and 1000000' }
    }
    limit = input.limit
  }

  let expiresAt: Date | null = null
  if (input.expiresAt !== null && input.expiresAt !== undefined && input.expiresAt !== '') {
    if (typeof input.expiresAt !== 'string') return { error: 'expiresAt must be an ISO date' }
    const parsed = new Date(input.expiresAt)
    if (Number.isNaN(parsed.getTime())) return { error: 'expiresAt must be an ISO date' }
    expiresAt = parsed
  }

  return { featureKey, enabled: input.enabled, limit, expiresAt }
}
