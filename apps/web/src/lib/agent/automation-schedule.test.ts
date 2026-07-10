import { describe, expect, it } from 'vitest'
import { nextRunAfterCurrent, nextRunAtFromCron } from './automation-schedule'

describe('automation schedule helpers', () => {
  it('computes the next daily run in UTC server time', () => {
    expect(nextRunAtFromCron('0 9 * * *', new Date('2026-06-22T08:30:00Z'))?.toISOString())
      .toBe('2026-06-22T09:00:00.000Z')
  })

  it('computes the next daily run in the automation timezone', () => {
    expect(nextRunAtFromCron('0 9 * * *', new Date('2026-06-22T06:30:00Z'), 'Europe/Berlin')?.toISOString())
      .toBe('2026-06-22T07:00:00.000Z')
  })

  it('uses winter timezone offsets when computing local runs', () => {
    expect(nextRunAtFromCron('0 9 * * *', new Date('2026-01-22T07:30:00Z'), 'Europe/Berlin')?.toISOString())
      .toBe('2026-01-22T08:00:00.000Z')
  })

  it('skips to the next allowed weekday', () => {
    expect(nextRunAtFromCron('0 9 * * 1-5', new Date('2026-06-26T10:00:00Z'))?.toISOString())
      .toBe('2026-06-29T09:00:00.000Z')
  })

  it('skips to the next allowed weekday in the automation timezone', () => {
    expect(nextRunAtFromCron('0 9 * * 1-5', new Date('2026-06-26T10:00:00Z'), 'Europe/Berlin')?.toISOString())
      .toBe('2026-06-29T07:00:00.000Z')
  })

  it('advances after a current due run', () => {
    expect(nextRunAfterCurrent('0 9 * * *', new Date('2026-06-22T09:00:00Z'))?.toISOString())
      .toBe('2026-06-23T09:00:00.000Z')
  })

  it('falls back to UTC for invalid timezones', () => {
    expect(nextRunAtFromCron('0 9 * * *', new Date('2026-06-22T08:30:00Z'), 'Not/AZone')?.toISOString())
      .toBe('2026-06-22T09:00:00.000Z')
  })

  it('returns null for unsupported cron expressions', () => {
    expect(nextRunAtFromCron('*/10 * * * *')).toBeNull()
  })
})
