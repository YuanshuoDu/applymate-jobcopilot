import { describe, expect, it } from 'vitest'
import { PLAN_SELECT, buildPlanPatch, buildEntitlementPatch, validateEntitlement, validatePlanMetadata, validatePlanTransition, validateFeatureOverride, toPlanCatalogDto, type PlanKey } from './plans'

describe('admin plan validation', () => {
  it('keeps the plan selector outside route modules', () => {
    expect(PLAN_SELECT).toMatchObject({ id: true, plan: true, entitlements: { select: { id: true } } })
  })

  it('normalizes valid EUR pricing and rejects negative or fractional cents', () => {
    expect(validatePlanMetadata({ name: 'Pro', monthlyPriceCents: 1900, yearlyPriceCents: 19000, currency: 'eur' })).toMatchObject({ currency: 'EUR', monthlyPriceCents: 1900 })
    expect(() => validatePlanMetadata({ name: 'Pro', monthlyPriceCents: -1, yearlyPriceCents: 19000, currency: 'EUR' })).toThrow()
    expect(() => validatePlanMetadata({ name: 'Pro', monthlyPriceCents: 10.5, yearlyPriceCents: 19000, currency: 'EUR' })).toThrow()
  })

  it('enforces entitlement value shape by kind', () => {
    expect(validateEntitlement({ featureKey: 'auto_apply', kind: 'boolean', enabled: true })).toMatchObject({ featureKey: 'auto_apply', kind: 'boolean' })
    expect(() => validateEntitlement({ featureKey: 'ai_credits', kind: 'limit', enabled: true })).toThrow()
    expect(validateEntitlement({ featureKey: 'ai_credits', kind: 'limit', enabled: true, limit: 100 })).toMatchObject({ limit: 100 })
    expect(() => validateEntitlement({ featureKey: 'label', kind: 'text', enabled: true })).toThrow()
  })

  it('rejects transitions whose destination plan is inactive', () => {
    const active = new Set<PlanKey>(['free', 'pro'])
    expect(validatePlanTransition({ fromPlan: 'free', toPlan: 'pro', enabled: true }, active)).toMatchObject({ toPlan: 'pro' })
    expect(() => validatePlanTransition({ fromPlan: 'free', toPlan: 'enterprise', enabled: true }, active)).toThrow()
  })

  it('bounds feature overrides and requires a future expiry when supplied', () => {
    expect(validateFeatureOverride({ featureKey: 'auto_apply', enabled: true, limit: null, expiresAt: '2099-01-01T00:00:00.000Z' })).toMatchObject({ enabled: true })
    expect(() => validateFeatureOverride({ featureKey: 'unknown', enabled: true })).toThrow()
    expect(() => validateFeatureOverride({ featureKey: 'auto_apply', enabled: true, limit: -1 })).toThrow()
    expect(() => validateFeatureOverride({ featureKey: 'auto_apply', enabled: true, expiresAt: '2000-01-01T00:00:00.000Z' })).toThrow()
  })

  it('builds a plan DTO from an explicit safe shape', () => {
    expect(toPlanCatalogDto({ id: 'plan_1', plan: 'pro', name: 'Pro', monthlyPriceCents: 1900, yearlyPriceCents: 19000, currency: 'EUR', active: true, version: 2, entitlements: [{ id: 'ent_1', featureKey: 'auto_apply', kind: 'boolean', enabled: true }] })).toMatchObject({ plan: 'pro', version: 2, entitlements: [{ featureKey: 'auto_apply' }] })
  })

  it('builds an active-state plan patch for activation controls', () => {
    expect(buildPlanPatch({ name: 'Pro', description: 'Full access', monthlyPriceCents: 1900, yearlyPriceCents: 19000, currency: 'EUR', active: false })).toEqual({ name: 'Pro', description: 'Full access', monthlyPriceCents: 1900, yearlyPriceCents: 19000, currency: 'EUR', active: false })
  })

  it('keeps text entitlement values in the update payload', () => {
    expect(buildEntitlementPatch([{ featureKey: 'support', kind: 'text', enabled: true, textValue: 'Priority support' }])).toEqual([{ featureKey: 'support', kind: 'text', enabled: true, textValue: 'Priority support' }])
  })
})
