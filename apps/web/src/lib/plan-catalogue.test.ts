import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAN_CATALOGUE,
  formatPlanPrice,
  normalizePlanRow,
  toPublicPlan,
} from './plan-catalogue-shared'

describe('plan catalogue', () => {
  it('exposes the settings pricing baseline as defaults', () => {
    expect(DEFAULT_PLAN_CATALOGUE.map(plan => [plan.key, plan.priceMinor])).toEqual([
      ['free', 0],
      ['pro', 1200],
      ['enterprise', 2900],
    ])
  })

  it('formats minor currency units for public cards', () => {
    expect(formatPlanPrice({ priceMinor: 0, currency: 'EUR' })).toBe('€0')
    expect(formatPlanPrice({ priceMinor: 1250, currency: 'EUR' })).toBe('€12.50')
  })

  it('normalizes malformed stored feature data without throwing', () => {
    const plan = normalizePlanRow({
      plan: 'pro',
      name: ' Pro ',
      priceMinor: 1200,
      currency: 'eur',
      interval: 'month',
      description: ' Serious job seekers ',
      features: ['Unlimited applications', 42, '  '],
      badge: ' Popular ',
      cta: ' Start ',
      trialDays: 14,
      active: true,
      sortOrder: 2,
    })

    expect(plan).toMatchObject({
      key: 'pro',
      name: 'Pro',
      currency: 'EUR',
      features: ['Unlimited applications'],
      badge: 'Popular',
      cta: 'Start',
    })
    expect(toPublicPlan(plan)).toMatchObject({ price: '€12', period: 'month' })
  })

  it('falls back to a valid default for an unknown plan key', () => {
    expect(normalizePlanRow({ plan: 'unknown', features: ['x'] }).key).toBe('free')
  })
})
