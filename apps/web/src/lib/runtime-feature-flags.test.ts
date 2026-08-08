import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUser: vi.fn(), findFlag: vi.fn() }))

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.findUser },
    platformFeatureFlag: { findUnique: mocks.findFlag },
  },
}))

import { isRuntimeFeatureEnabled } from './runtime-feature-flags'

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
})
