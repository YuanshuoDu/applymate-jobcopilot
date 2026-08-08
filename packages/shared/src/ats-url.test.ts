import { describe, expect, it } from 'vitest'
import { detectAtsSource } from './ats-url.js'

describe('ATS URL classification', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/123', 'greenhouse'],
    ['https://booking.greenhouse.io/jobs/123', 'greenhouse'],
    ['https://job-boards.greenhouse.io/embed/job_app?for=acme', 'greenhouse'],
    ['https://app.lever.co/posting/acme/123', 'lever'],
    ['https://careers.smartrecruiters.com/acme/jobs/123', 'smartrecruiters'],
    ['https://acme.wd3.myworkdayjobs.com/en-US/jobs/123', 'workday'],
    ['https://acme.jobs.personio.com/job/123', 'personio'],
  ] as const)('classifies %s as %s', (url, expected) => {
    expect(detectAtsSource(url)).toBe(expected)
  })

  it('rejects broad vendor domains that are not direct application URLs', () => {
    expect(detectAtsSource('https://greenhouse.io/products')).toBeNull()
    expect(detectAtsSource('https://job-boards.greenhouse.io/embed/job_app')).toBeNull()
    expect(detectAtsSource('https://lever.co/blog')).toBeNull()
    expect(detectAtsSource('https://smartrecruiters.com/resources')).toBeNull()
  })
})
