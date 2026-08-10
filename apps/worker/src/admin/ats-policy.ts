import type { Pool } from 'pg'
import { getDefaultAtsPolicy, getHardRpsLimit, isAtsSourceKey, type AtsSourceKey } from '@jobcopilot/shared'

type PolicyMode = 'discovery' | 'auto_apply'
type Sleep = (milliseconds: number) => Promise<void>
type PolicyRow = Record<string, unknown>

export type EffectiveAtsPolicy = {
  sourceKey: AtsSourceKey
  configured: boolean
  version: number | null
  state: string
  enabled: boolean
  rolloutPercent: number
  globalRpsLimit: number
  perTenantRpsLimit: number
  maxRetries: number
  backoffBaseMs: number
  allowAutoApply: boolean
  discoveryAllowed: boolean
  autoApplyAllowed: boolean
}

export type AtsPolicyRedis = {
  set(key: string, value: string, mode: 'PX', milliseconds: number, condition: 'NX'): Promise<'OK' | null>
  pttl(key: string): Promise<number>
}

export async function loadEffectiveAtsPolicy(pool: Pick<Pool, 'query'>, sourceKey: string): Promise<EffectiveAtsPolicy> {
  if (!isAtsSourceKey(sourceKey)) throw new Error('Unknown ATS policy source')
  const hardLimit = getHardRpsLimit(sourceKey)
  if (!hardLimit) throw new Error('Missing ATS policy ceiling')

  let rows: PolicyRow[]
  try {
    const result = await pool.query<PolicyRow>(`
      SELECT state::text, enabled, rollout_percent, global_rps_limit,
        per_tenant_rps_limit, max_retries, backoff_base_ms, allow_auto_apply, version
      FROM ats_source_policies
      WHERE source_key = $1
    `, [sourceKey])
    rows = result.rows
  } catch (error) {
    throw new Error(`ATS policy lookup failed for ${sourceKey}`, { cause: error })
  }

  const row = rows[0]
  if (!row) return fallbackPolicy(sourceKey)
  const policy: EffectiveAtsPolicy = {
    sourceKey,
    configured: true,
    version: positiveInteger(row.version) ?? null,
    state: knownState(row.state),
    enabled: row.enabled === true,
    rolloutPercent: boundedInteger(row.rollout_percent, 0, 100, 100),
    globalRpsLimit: boundedInteger(row.global_rps_limit, 1, hardLimit, hardLimit),
    perTenantRpsLimit: 1,
    maxRetries: boundedInteger(row.max_retries, 0, 10, 3),
    backoffBaseMs: boundedInteger(row.backoff_base_ms, 100, 120_000, 1_000),
    allowAutoApply: row.allow_auto_apply === true,
    discoveryAllowed: false,
    autoApplyAllowed: false,
  }
  policy.perTenantRpsLimit = boundedInteger(row.per_tenant_rps_limit, 1, policy.globalRpsLimit, policy.globalRpsLimit)
  policy.discoveryAllowed = canUseAtsSource(policy, '', 'discovery')
  policy.autoApplyAllowed = canUseAtsSource(policy, '', 'auto_apply')
  return policy
}

export function canUseAtsSource(policy: EffectiveAtsPolicy, userId: string, mode: PolicyMode): boolean {
  if (!policy.configured) return true
  if (!policy.enabled || !['enabled', 'degraded'].includes(policy.state)) return false
  if (mode === 'auto_apply' && !policy.allowAutoApply) return false
  if (policy.rolloutPercent <= 0) return false
  if (policy.rolloutPercent >= 100) return true
  return rolloutBucket(`${policy.sourceKey}:${userId}`) < policy.rolloutPercent
}

export async function acquireAtsPacing(
  redis: AtsPolicyRedis,
  policy: EffectiveAtsPolicy,
  userId: string,
  sleep: Sleep = wait,
): Promise<void> {
  await acquireSlot(redis, `ats:pace:${policy.sourceKey}:global`, intervalFor(policy.globalRpsLimit), sleep)
  await acquireSlot(redis, `ats:pace:${policy.sourceKey}:user:${userId}`, intervalFor(policy.perTenantRpsLimit), sleep)
}

export async function withAtsRetries<T>(
  policy: EffectiveAtsPolicy,
  operation: () => Promise<T>,
  sleep: Sleep = wait,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= policy.maxRetries || !shouldRetry(error)) throw error
      await sleep(Math.min(policy.backoffBaseMs * 2 ** attempt, 120_000))
    }
  }
}

function fallbackPolicy(sourceKey: AtsSourceKey): EffectiveAtsPolicy {
  return {
    sourceKey,
    configured: false,
    version: null,
    ...getDefaultAtsPolicy(sourceKey),
    discoveryAllowed: true,
    autoApplyAllowed: true,
  }
}

async function acquireSlot(redis: AtsPolicyRedis, key: string, interval: number, sleep: Sleep): Promise<void> {
  while (await redis.set(key, '1', 'PX', interval, 'NX') !== 'OK') {
    const ttl = await redis.pttl(key)
    await sleep(ttl > 0 ? Math.min(ttl, interval) : interval)
  }
}

function intervalFor(rps: number): number {
  return Math.ceil(1_000 / rps)
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function knownState(value: unknown): string {
  return typeof value === 'string' && ['enabled', 'degraded', 'pending_pause', 'paused', 'disabled'].includes(value)
    ? value
    : 'disabled'
}

function rolloutBucket(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return (hash >>> 0) % 100
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
