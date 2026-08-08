import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  acquireAtsPacing,
  canUseAtsSource,
  loadEffectiveAtsPolicy,
  withAtsRetries,
} from './ats-policy.js'

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    state: 'enabled',
    enabled: true,
    rollout_percent: 100,
    global_rps_limit: 50,
    per_tenant_rps_limit: 20,
    max_retries: 2,
    backoff_base_ms: 100,
    allow_auto_apply: true,
    version: 4,
    ...overrides,
  }
}

function poolWith(rows: Record<string, unknown>[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool
}

describe('effective ATS policy', () => {
  it('preserves existing behavior without a row and fails closed when the lookup errors', async () => {
    await expect(loadEffectiveAtsPolicy(poolWith([]), 'lever')).resolves.toMatchObject({
      configured: false,
      discoveryAllowed: true,
      autoApplyAllowed: true,
    })
    const unavailable = { query: vi.fn().mockRejectedValue(new Error('database offline')) } as unknown as Pool
    await expect(loadEffectiveAtsPolicy(unavailable, 'lever')).rejects.toThrow('ATS policy lookup failed')
  })

  it('clamps database limits to the shared source ceiling and blocks paused sources', async () => {
    const policy = await loadEffectiveAtsPolicy(poolWith([policyRow({ state: 'paused', enabled: false })]), 'lever')

    expect(policy.globalRpsLimit).toBe(5)
    expect(policy.perTenantRpsLimit).toBe(5)
    expect(canUseAtsSource(policy, 'user-1', 'discovery')).toBe(false)
  })

  it('acquires source and user pacing slots with their effective intervals', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      pttl: vi.fn(),
    }
    const policy = await loadEffectiveAtsPolicy(poolWith([policyRow()]), 'lever')

    await acquireAtsPacing(redis, policy, 'user-1', vi.fn())

    expect(redis.set).toHaveBeenNthCalledWith(1, 'ats:pace:lever:global', '1', 'PX', 200, 'NX')
    expect(redis.set).toHaveBeenNthCalledWith(2, 'ats:pace:lever:user:user-1', '1', 'PX', 200, 'NX')
  })

  it('retries a provider operation with bounded exponential backoff', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue('ok')
    const sleep = vi.fn().mockResolvedValue(undefined)
    const policy = await loadEffectiveAtsPolicy(poolWith([policyRow()]), 'lever')

    await expect(withAtsRetries(policy, operation, sleep)).resolves.toBe('ok')

    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 100)
    expect(sleep).toHaveBeenNthCalledWith(2, 200)
  })
})
