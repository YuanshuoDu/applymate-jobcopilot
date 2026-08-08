import { describe, expect, it } from 'vitest'
import {
  dailyNotificationId,
  formatWeeklySummary,
  isWeeklySummaryDay,
  utcWeekKey,
} from './daily'

describe('daily notification helpers', () => {
  it('uses stable UTC keys for idempotent scheduled work', () => {
    const now = new Date('2026-08-03T08:30:00.000Z')
    expect(isWeeklySummaryDay(now)).toBe(true)
    expect(utcWeekKey(now)).toBe('2026-W32')
    expect(dailyNotificationId('weekly', 'user_1', utcWeekKey(now))).toBe('daily:weekly:user_1:2026-W32')
  })

  it('formats a compact, actionable weekly summary', () => {
    expect(formatWeeklySummary({ applied: 3, interviews: 1, offers: 0, rejections: 2, newJobs: 7 })).toEqual({
      title: 'Your ApplyMate weekly summary',
      body: '3 applications, 1 interview, 0 offers, 2 rejections, 7 new jobs.',
    })
  })
})
