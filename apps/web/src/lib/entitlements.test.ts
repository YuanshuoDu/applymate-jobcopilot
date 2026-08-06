import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  overrideFindUnique: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique },
    planCatalog: { findUnique: mocks.planFindUnique },
    userFeatureOverride: { findUnique: mocks.overrideFindUnique },
    $queryRaw: mocks.queryRaw,
  },
}))

import { isFeatureAllowed, resolveAiAccess, resolveEntitlement, resolveEntitlementLimit } from './entitlements'

describe('runtime plan entitlements', () => {
  beforeEach(() => {
    mocks.userFindUnique.mockReset()
    mocks.planFindUnique.mockReset()
    mocks.overrideFindUnique.mockReset()
    mocks.queryRaw.mockReset()
    mocks.userFindUnique.mockResolvedValue({ plan: 'free' })
    mocks.planFindUnique.mockResolvedValue({ entitlements: [{ featureKey: 'auto_apply', kind: 'boolean', enabled: false, limit: null, textValue: null }] })
    mocks.overrideFindUnique.mockResolvedValue(null)
  })

  it('blocks a feature disabled by the current plan', async () => {
    await expect(isFeatureAllowed('user-1', 'auto_apply')).resolves.toBe(false)
    await expect(resolveEntitlement('user-1', 'auto_apply')).resolves.toMatchObject({ enabled: false, source: 'plan' })
  })

  it('lets an active user override replace the plan entitlement', async () => {
    mocks.overrideFindUnique.mockResolvedValue({ featureKey: 'auto_apply', enabled: true, limit: null, expiresAt: new Date('2099-01-01T00:00:00Z') })
    await expect(isFeatureAllowed('user-1', 'auto_apply')).resolves.toBe(true)
    await expect(resolveEntitlement('user-1', 'auto_apply')).resolves.toMatchObject({ enabled: true, source: 'override' })
  })

  it('ignores an expired user override', async () => {
    mocks.overrideFindUnique.mockResolvedValue({ featureKey: 'auto_apply', enabled: true, limit: null, expiresAt: new Date('2000-01-01T00:00:00Z') })
    await expect(isFeatureAllowed('user-1', 'auto_apply')).resolves.toBe(false)
  })

  it('fails open when the plan catalogue has not been seeded yet', async () => {
    mocks.planFindUnique.mockResolvedValue(null)
    await expect(isFeatureAllowed('user-1', 'auto_apply')).resolves.toBe(true)
    await expect(resolveEntitlement('user-1', 'auto_apply')).resolves.toBeNull()
  })

  it('treats a zero limit as unavailable and exposes the effective limit', async () => {
    mocks.planFindUnique.mockResolvedValue({ entitlements: [{ featureKey: 'ai_credits', kind: 'limit', enabled: true, limit: 0, textValue: null }] })

    await expect(isFeatureAllowed('user-1', 'ai_credits')).resolves.toBe(false)
    await expect(resolveEntitlementLimit('user-1', 'ai_credits')).resolves.toBe(0)
  })

  it('uses an active override limit instead of the plan limit', async () => {
    mocks.planFindUnique.mockResolvedValue({ entitlements: [{ featureKey: 'ai_credits', kind: 'limit', enabled: true, limit: 25, textValue: null }] })
    mocks.overrideFindUnique.mockResolvedValue({ featureKey: 'ai_credits', enabled: true, limit: 100, expiresAt: new Date('2099-01-01T00:00:00Z') })

    await expect(resolveEntitlementLimit('user-1', 'ai_credits')).resolves.toBe(100)
  })

  it('treats a limit override as a limit even before plan entitlements are seeded', async () => {
    mocks.planFindUnique.mockResolvedValue({ entitlements: [] })
    mocks.overrideFindUnique.mockResolvedValue({ featureKey: 'ai_credits', enabled: true, limit: 10, expiresAt: new Date('2099-01-01T00:00:00Z') })

    await expect(resolveEntitlement('user-1', 'ai_credits')).resolves.toMatchObject({ kind: 'limit', limit: 10, source: 'override' })
  })

  it('blocks AI usage after the current monthly limit is reached', async () => {
    mocks.planFindUnique.mockResolvedValue({ entitlements: [{ featureKey: 'ai_credits', kind: 'limit', enabled: true, limit: 25, textValue: null }] })
    mocks.queryRaw.mockResolvedValue([{ used: 25, limit: 30 }])

    const { isAiBudgetAvailable } = await import('./entitlements')
    await expect(isAiBudgetAvailable('user-1')).resolves.toBe(false)
    await expect(resolveAiAccess('user-1')).resolves.toBe('exhausted')
  })

  it('distinguishes a disabled AI entitlement from exhausted credits', async () => {
    mocks.planFindUnique.mockResolvedValue({ entitlements: [{ featureKey: 'ai_credits', kind: 'limit', enabled: false, limit: 25, textValue: null }] })

    await expect(resolveAiAccess('user-1')).resolves.toBe('disabled')
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })
})
