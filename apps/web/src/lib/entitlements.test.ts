import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  overrideFindMany: vi.fn(),
  getPlanCatalogue: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique }, userFeatureOverride: { findMany: mocks.overrideFindMany } } }))
vi.mock('./plan-catalogue', () => ({ getPlanCatalogue: mocks.getPlanCatalogue }))

describe('effective entitlements', () => {
  beforeEach(() => {
    mocks.userFindUnique.mockResolvedValue({ plan: 'pro', planSubscription: { status: 'active', currentPeriodEnd: null } })
    mocks.getPlanCatalogue.mockResolvedValue([{ key: 'pro', entitlements: ['applications:unlimited', 'auto_apply'] }])
    mocks.overrideFindMany.mockResolvedValue([])
  })

  it('resolves package entitlements at runtime', async () => {
    const { hasEffectiveEntitlement } = await import('./entitlements')
    await expect(hasEffectiveEntitlement('user_1', 'auto_apply')).resolves.toBe(true)
  })

  it('lets an unexpired user override grant or revoke a package entitlement', async () => {
    mocks.overrideFindMany.mockResolvedValueOnce([{ featureKey: 'auto_apply', enabled: false, limit: null, expiresAt: null }])
    const { hasEffectiveEntitlement, getEffectiveEntitlements } = await import('./entitlements')
    await expect(hasEffectiveEntitlement('user_1', 'auto_apply')).resolves.toBe(false)
    mocks.overrideFindMany.mockResolvedValueOnce([{ featureKey: 'team_seats', enabled: true, limit: 3, expiresAt: null }])
    await expect(getEffectiveEntitlements('user_1')).resolves.toEqual(expect.objectContaining({ limits: { applications: null, auto_apply: null, team_seats: 3 } }))
  })

  it('enforces a finite entitlement limit while allowing unlimited plans', async () => {
    mocks.getPlanCatalogue.mockResolvedValueOnce([{ key: 'free', entitlements: ['applications:5/month'] }])
    mocks.userFindUnique.mockResolvedValueOnce({ plan: 'free', planSubscription: { status: 'active', currentPeriodEnd: null } })
    const { checkEntitlementLimit } = await import('./entitlements')
    await expect(checkEntitlementLimit('user_1', 'applications', 4)).resolves.toMatchObject({ allowed: true, limit: 5 })
    mocks.getPlanCatalogue.mockResolvedValueOnce([{ key: 'free', entitlements: ['applications:5/month'] }])
    mocks.userFindUnique.mockResolvedValueOnce({ plan: 'free', planSubscription: { status: 'active', currentPeriodEnd: null } })
    await expect(checkEntitlementLimit('user_1', 'applications', 5)).resolves.toMatchObject({ allowed: false, reason: 'limit_reached' })
  })
})
