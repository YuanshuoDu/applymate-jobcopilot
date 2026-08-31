import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUser: vi.fn(), findFlag: vi.fn() }))

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.findUser },
    platformFeatureFlag: { findUnique: mocks.findFlag },
  },
}))

import { isRuntimeAgentHarnessFeatureEnabled, isRuntimeFeatureEnabled } from './runtime-feature-flags'

describe('Web runtime feature flags', () => {
  beforeEach(() => {
    mocks.findUser.mockReset()
    mocks.findFlag.mockReset()
    mocks.findUser.mockResolvedValue({ plan: 'pro' })
  })

  it('blocks an active disabled unattended-apply control', async () => {
    mocks.findFlag.mockResolvedValue({
      enabled: false,
      rolloutPercent: 100,
      targetPlans: [],
      targetUserIds: [],
      status: 'active',
      rollbackAt: null,
    })

    await expect(isRuntimeFeatureEnabled('unattended_apply', 'user-1', 'production')).resolves.toBe(false)
  })

  it('keeps missing V2 controls on the safe default', async () => {
    mocks.findFlag.mockResolvedValue(null)

    await expect(isRuntimeAgentHarnessFeatureEnabled('AGENT_CHAT_LOOP_V2', 'user-1', 'staging')).resolves.toBe(false)
  })

  it('uses the shared resolver for an active V2 override', async () => {
    mocks.findFlag.mockResolvedValue({
      enabled: true,
      rolloutPercent: 100,
      targetPlans: [],
      targetUserIds: [],
      status: 'active',
      rollbackAt: null,
    })

    await expect(isRuntimeAgentHarnessFeatureEnabled('AGENT_PROTOCOL_V2_DUAL_WRITE', 'user-1', 'staging')).resolves.toBe(true)
  })

  it('fails closed when the V2 flag table is unavailable', async () => {
    mocks.findFlag.mockRejectedValue({ code: 'P2021' })

    await expect(isRuntimeAgentHarnessFeatureEnabled('AGENT_BROWSER_TOOL_V2', 'user-1', 'production')).resolves.toBe(false)
  })
})
