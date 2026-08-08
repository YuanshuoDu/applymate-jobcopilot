import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { isWorkerFeatureEnabled } from './runtime-feature-flags.js'

function poolWith(rows: Array<Record<string, unknown>>) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ plan: 'pro' }] })
    .mockResolvedValueOnce({ rows })
  return { pool: { query } as unknown as Pool, query }
}

describe('Worker runtime feature flags', () => {
  it('blocks an active disabled unattended-apply control before execution', async () => {
    const { pool } = poolWith([{
      enabled: false,
      rolloutPercent: 100,
      targetPlans: [],
      targetUserIds: [],
      status: 'active',
      rollbackAt: null,
    }])

    await expect(isWorkerFeatureEnabled(pool, 'unattended_apply', 'user-1', 'production')).resolves.toBe(false)
  })
})
