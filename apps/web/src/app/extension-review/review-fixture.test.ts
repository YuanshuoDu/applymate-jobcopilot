import { describe, expect, it } from 'vitest'
import { REVIEW_JOB, reviewJobJsonLd } from './review-fixture'

describe('public extension review fixture', () => {
  it('identifies a fictional role and has enough job data for the real scraper', () => {
    const job = JSON.parse(reviewJobJsonLd())
    expect(job['@type']).toBe('JobPosting')
    expect(job.title).toContain('fictional')
    expect(job.hiringOrganization.name).toContain('fictional')
    expect(job.jobLocation.address.addressLocality).toBe('Dublin')
    expect(job.description.length).toBeGreaterThan(80)
    expect(job.description).toContain('no application will be submitted')
  })

  it('does not redirect saved jobs to a real employer or publish candidate details', () => {
    expect(REVIEW_JOB).not.toHaveProperty('url')
    expect(REVIEW_JOB).not.toHaveProperty('applicationContact')
    expect(reviewJobJsonLd()).not.toContain('</script')
    expect(reviewJobJsonLd()).not.toContain('@example.com')
  })
})
