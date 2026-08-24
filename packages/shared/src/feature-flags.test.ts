import { describe, expect, it } from 'vitest'
import { evaluateManagedFeature, isManagedFeatureKey } from './feature-flags.js'

describe('managed platform feature flags', () => {
  it('keeps the current product behavior when no active override exists', () => {
    expect(evaluateManagedFeature('unattended_apply', {
      environment: 'production',
      userId: 'user-1',
      plan: 'pro',
      flag: null,
    })).toBe(true)
  })

  it('applies a global disabled override before any rollout target', () => {
    expect(evaluateManagedFeature('worker_discovery', {
      environment: 'production',
      userId: 'user-1',
      plan: 'pro',
      flag: {
        enabled: false,
        rolloutPercent: 100,
        targetPlans: [],
        targetUserIds: ['user-1'],
        status: 'active',
        rollbackAt: null,
      },
    })).toBe(false)
  })

  it('allows only registered operational keys', () => {
    expect(isManagedFeatureKey('unattended_apply')).toBe(true)
    expect(isManagedFeatureKey('fantasticjobs_shadow')).toBe(true)
    expect(isManagedFeatureKey('new_feature')).toBe(false)
  })

  it('keeps Fantastic.jobs Shadow disabled until explicitly rolled out', () => {
    expect(evaluateManagedFeature('fantasticjobs_shadow', {
      environment: 'production',
      userId: 'user-1',
      plan: 'pro',
      flag: null,
    })).toBe(false)
  })
})
