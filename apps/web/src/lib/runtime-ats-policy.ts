import { getDefaultAtsPolicy, getHardRpsLimit, isAtsSourceKey } from '@jobcopilot/shared'
import { db } from '@/lib/db'

export type RuntimeAtsPolicy = {
  allowed: boolean
  rps: number
}

/** Resolve the current ATS policy before a Web-owned outbound request. */
export async function getRuntimeAtsPolicy(
  sourceKey: string,
  userId?: string,
): Promise<RuntimeAtsPolicy> {
  const hardLimit = getHardRpsLimit(sourceKey)
  if (!isAtsSourceKey(sourceKey) || !hardLimit) return { allowed: false, rps: 1 }
  const defaultPolicy = getDefaultAtsPolicy(sourceKey)

  try {
    const policy = await db.atsSourcePolicy.findUnique({
      where: { sourceKey },
      select: {
        state: true,
        enabled: true,
        rolloutPercent: true,
        globalRpsLimit: true,
        perTenantRpsLimit: true,
        allowAutoApply: true,
      },
    })
    if (!policy) return { allowed: true, rps: defaultPolicy.perTenantRpsLimit }

    const globalRps = boundedInteger(policy.globalRpsLimit, 1, hardLimit, hardLimit)
    const rps = boundedInteger(policy.perTenantRpsLimit, 1, globalRps, globalRps)
    return { allowed: policyAllowsDiscovery(policy, sourceKey, userId), rps }
  } catch (error) {
    if (isMissingPolicyTable(error)) return { allowed: true, rps: defaultPolicy.perTenantRpsLimit }
    return { allowed: false, rps: hardLimit }
  }
}

function policyAllowsDiscovery(
  policy: { state: unknown; enabled: unknown; rolloutPercent: unknown; allowAutoApply: unknown },
  sourceKey: string,
  userId?: string,
): boolean {
  if (policy.enabled !== true || (policy.state !== 'enabled' && policy.state !== 'degraded')) return false
  const rolloutPercent = boundedInteger(policy.rolloutPercent, 0, 100, 100)
  if (rolloutPercent <= 0) return false
  if (rolloutPercent >= 100) return true
  return Boolean(userId && rolloutBucket(`${sourceKey}:${userId}`) < rolloutPercent)
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback
}

function rolloutBucket(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return (hash >>> 0) % 100
}

function isMissingPolicyTable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2021'
}
