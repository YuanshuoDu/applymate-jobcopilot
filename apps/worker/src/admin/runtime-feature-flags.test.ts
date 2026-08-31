import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { isWorkerAgentHarnessFeatureEnabled, isWorkerFeatureEnabled } from './runtime-feature-flags.js'

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

  it('keeps missing V2 controls on the safe default', async () => {
    const { pool } = poolWith([])

    await expect(isWorkerAgentHarnessFeatureEnabled(pool, 'AGENT_CHAT_LOOP_V2', 'user-1', 'staging')).resolves.toBe(false)
  })

  it('uses the shared resolver for an active V2 override', async () => {
    const { pool } = poolWith([{
      enabled: true,
      rolloutPercent: 100,
      targetPlans: [],
      targetUserIds: [],
      status: 'active',
      rollbackAt: null,
    }])

    await expect(isWorkerAgentHarnessFeatureEnabled(pool, 'AGENT_PROTOCOL_V2_DUAL_WRITE', 'user-1', 'staging')).resolves.toBe(true)
  })

  it('fails closed when the V2 flag table is unavailable', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ plan: 'pro' }] })
      .mockRejectedValueOnce({ code: '42P01' })

    await expect(isWorkerAgentHarnessFeatureEnabled({ query } as never, 'AGENT_BROWSER_TOOL_V2', 'user-1', 'production')).resolves.toBe(false)
  })
})
