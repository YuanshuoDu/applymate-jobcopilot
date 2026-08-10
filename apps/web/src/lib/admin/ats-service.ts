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

export function isAtsSourceKey(value: string) {
  return isSharedAtsSourceKey(value)
}

export function hardRpsLimit(sourceKey: string) {
  return getHardRpsLimit(sourceKey) ?? 0
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
