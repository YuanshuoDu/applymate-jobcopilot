import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safeAuth: vi.fn(),
  findUnique: vi.fn(),
}))

vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique } } }))

import { getUsageAnalyticsConsent } from './usage-analytics'

describe('getUsageAnalyticsConsent', () => {
  beforeEach(() => {
    mocks.safeAuth.mockReset()
    mocks.findUnique.mockReset()
  })

  it('fails closed without an authenticated user', async () => {
    mocks.safeAuth.mockResolvedValue(null)

    await expect(getUsageAnalyticsConsent()).resolves.toBe(false)
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })

  it('uses the persisted privacy preference for an authenticated user', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mocks.findUnique.mockResolvedValue({ preferences: { privacyPreferences: { shareUsageData: false } } })

    await expect(getUsageAnalyticsConsent()).resolves.toBe(false)
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      select: { preferences: true },
    })
  })

  it('enables analytics only when the stored preference opts in', async () => {
    mocks.safeAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mocks.findUnique.mockResolvedValue({ preferences: { privacyPreferences: { shareUsageData: true } } })

    await expect(getUsageAnalyticsConsent()).resolves.toBe(true)
  })

  it('fails closed when the session or preference lookup fails', async () => {
    mocks.safeAuth.mockRejectedValue(new Error('auth unavailable'))

    await expect(getUsageAnalyticsConsent()).resolves.toBe(false)
  })
})
