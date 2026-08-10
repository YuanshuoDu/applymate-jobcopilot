import { describe, expect, it } from 'vitest'
import { classifyPlanChange, shouldScheduleDowngrade } from './plan-change-policy'

describe('plan change policy', () => {
  it('classifies plan changes by catalogue rank', () => {
    expect(classifyPlanChange('free', 'pro')).toBe('upgrade')
    expect(classifyPlanChange('enterprise', 'pro')).toBe('downgrade')
    expect(classifyPlanChange('pro', 'pro')).toBe('same')
  })

  it('schedules a downgrade at the current period boundary', () => {
    const now = new Date('2026-08-10T00:00:00Z')
    expect(shouldScheduleDowngrade({ from: 'pro', to: 'free', currentPeriodEnd: new Date('2026-09-10T00:00:00Z'), now })).toBe(true)
    expect(shouldScheduleDowngrade({ from: 'pro', to: 'free', currentPeriodEnd: new Date('2026-08-01T00:00:00Z'), now })).toBe(false)
    expect(shouldScheduleDowngrade({ from: 'pro', to: 'free', currentPeriodEnd: new Date('2026-09-10T00:00:00Z'), now, applyImmediately: true })).toBe(false)
  })
})
