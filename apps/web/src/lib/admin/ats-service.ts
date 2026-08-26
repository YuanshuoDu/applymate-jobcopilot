import { AtsSourceState } from '@prisma/client'
import { getHardRpsLimit, isAtsSourceKey as isSharedAtsSourceKey } from '@jobcopilot/shared'

export type AtsPolicyInput = {
  rolloutPercent: number
  globalRpsLimit: number
  perTenantRpsLimit: number
  maxRetries: number
  backoffBaseMs: number
  allowAutoApply: boolean
  version: number
}

export const MANAGED_ATS_REGISTRY_SOURCES = ['greenhouse', 'lever'] as const

export type AtsEmployerRegistration = {
  atsType: (typeof MANAGED_ATS_REGISTRY_SOURCES)[number]
  slug: string
  name: string
  country: string | null
  enabled: boolean
}

export type AtsEmployerUpdate = Omit<AtsEmployerRegistration, 'atsType' | 'slug'> & { version: number }

export function isAtsSourceKey(value: string) {
  return isSharedAtsSourceKey(value)
}

export function hardRpsLimit(sourceKey: string) {
  return getHardRpsLimit(sourceKey) ?? 0
}

export function isManagedAtsRegistrySource(value: string): value is AtsEmployerRegistration['atsType'] {
  return MANAGED_ATS_REGISTRY_SOURCES.some(source => source === value)
}

function employerFields(value: Record<string, unknown>) {
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 160) : ''
  const countryValue = typeof value.country === 'string' ? value.country.trim().toLowerCase() : ''
  const country = countryValue || null
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : true
  if (!name || (country !== null && !/^[a-z]{2}$/.test(country))) return null
  return { name, country, enabled }
}

export function parseAtsEmployerRegistration(value: unknown): AtsEmployerRegistration | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const atsType = typeof input.atsType === 'string' ? input.atsType.trim().toLowerCase() : ''
  const slug = typeof input.slug === 'string' ? input.slug.trim() : ''
  const fields = employerFields(input)
  if (!isManagedAtsRegistrySource(atsType) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,100}$/.test(slug) || !fields) return null
  return { atsType, slug, ...fields }
}

export function parseAtsEmployerUpdate(value: unknown): AtsEmployerUpdate | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (typeof input.enabled !== 'boolean') return null
  const fields = employerFields(input)
  const version = input.version
  if (!fields || !Number.isInteger(version) || Number(version) < 1) return null
  return { ...fields, version: Number(version) }
}

export function parseAtsPolicy(value: unknown): AtsPolicyInput | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const values = ['rolloutPercent', 'globalRpsLimit', 'perTenantRpsLimit', 'maxRetries', 'backoffBaseMs', 'version']
  if (values.some((key) => !Number.isInteger(input[key]))) return null
  const rolloutPercent = input.rolloutPercent as number
  const globalRpsLimit = input.globalRpsLimit as number
  const perTenantRpsLimit = input.perTenantRpsLimit as number
  const maxRetries = input.maxRetries as number
  const backoffBaseMs = input.backoffBaseMs as number
  const version = input.version as number
  if (rolloutPercent < 0 || rolloutPercent > 100 || globalRpsLimit < 1 || perTenantRpsLimit < 1 || perTenantRpsLimit > globalRpsLimit || maxRetries < 0 || maxRetries > 10 || backoffBaseMs < 100 || backoffBaseMs > 120_000 || version < 1 || typeof input.allowAutoApply !== 'boolean') return null
  return { rolloutPercent, globalRpsLimit, perTenantRpsLimit, maxRetries, backoffBaseMs, allowAutoApply: input.allowAutoApply, version }
}

export function policyStateForEnabled(enabled: boolean): AtsSourceState {
  return enabled ? AtsSourceState.enabled : AtsSourceState.disabled
}
