import { describe, expect, it } from 'vitest'
import { extractInterviewSchedule } from './interview-schedule'

const reference = new Date(2026, 6, 30, 9, 0)

describe('extractInterviewSchedule', () => {
  it('extracts day-first interview dates and times', () => {
    expect(extractInterviewSchedule('Your interview is Thursday 31 July 2026 at 10:30 AM.', reference)?.toISOString()).toBe(new Date(2026, 6, 31, 10, 30).toISOString())
  })

  it('extracts month-first dates and infers the next occurrence', () => {
    expect(extractInterviewSchedule('We look forward to meeting on August 3 at 2pm.', reference)?.toISOString()).toBe(new Date(2026, 7, 3, 14, 0).toISOString())
  })

  it('extracts a relative tomorrow interview time', () => {
    expect(extractInterviewSchedule('Can you join the interview tomorrow at 09:15?', reference)?.toISOString()).toBe(new Date(2026, 6, 31, 9, 15).toISOString())
  })

  it('does not invent a schedule when a date or time is missing', () => {
    expect(extractInterviewSchedule('We would like to schedule an interview soon.', reference)).toBeNull()
  })
})
