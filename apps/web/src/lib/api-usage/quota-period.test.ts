import { describe, expect, it } from 'vitest'
import { quotaPeriodBounds } from './quota-period'

describe('quotaPeriodBounds', () => {
  it('uses the configured UTC weekday for weekly quotas', () => {
    const bounds = quotaPeriodBounds('week', 1, new Date('2026-08-23T12:00:00Z'))
    expect(bounds.start.toISOString()).toBe('2026-08-17T00:00:00.000Z')
    expect(bounds.end.toISOString()).toBe('2026-08-24T00:00:00.000Z')
  })

  it('rolls monthly quotas across the prior month before reset day', () => {
    const bounds = quotaPeriodBounds('month', 15, new Date('2026-08-03T12:00:00Z'))
    expect(bounds.start.toISOString()).toBe('2026-07-15T00:00:00.000Z')
    expect(bounds.end.toISOString()).toBe('2026-08-15T00:00:00.000Z')
  })
})
