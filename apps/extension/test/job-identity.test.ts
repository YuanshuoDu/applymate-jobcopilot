import { describe, expect, it } from 'vitest'
import { getJobIdentity, isSameJob } from '../src/lib/job-identity'

describe('getJobIdentity', () => {
  it('matches LinkedIn list and detail URLs by job ID', () => {
    expect(getJobIdentity({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/123456789/' }))
      .toBe(getJobIdentity({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/search/?currentJobId=123456789' }))
  })

  it('matches Indeed URLs by the stable job key', () => {
    expect(getJobIdentity({ source: 'indeed', url: 'https://ie.indeed.com/viewjob?jk=abc123&utm_source=test' }))
      .toBe(getJobIdentity({ source: 'indeed', url: 'https://ie.indeed.com/jobs?q=engineer&vjk=abc123' }))
  })

  it('ignores tracking fragments for other job boards', () => {
    expect(getJobIdentity({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=test#apply' }))
      .toBe(getJobIdentity({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' }))
  })

  it('matches a weak LinkedIn list card with its provider-id detail record', () => {
    expect(isSameJob(
      { source: 'linkedin', url: 'https://www.linkedin.com/jobs/search-results/?keywords=engineer', title: 'Graduate Software Engineer', company: 'Wayflyer', location: 'Dublin (Hybrid)' },
      { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4454070080/', role: 'Graduate Software Engineer', company: 'Wayflyer', location: 'Dublin, County Dublin, Ireland' },
    )).toBe(true)
  })

  it('does not use the selected LinkedIn job id for every virtualized list card', () => {
    const first = { source: 'linkedin', url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4454070080#applymate-card=wayflyer', title: 'Graduate Software Engineer', company: 'Wayflyer', location: 'Dublin (Hybrid)' }
    const second = { source: 'linkedin', url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=4454070080#applymate-card=deloitte', title: 'AI Engineer', company: 'Deloitte', location: 'Dublin (Hybrid)' }
    expect(getJobIdentity(first)).not.toBe(getJobIdentity(second))
    expect(isSameJob(first, { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4454070080/', role: first.title, company: first.company, location: first.location })).toBe(true)
    expect(isSameJob(second, { source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4454070080/', role: first.title, company: first.company, location: first.location })).toBe(false)
  })

  it('does not merge two different strong Indeed postings with the same text', () => {
    expect(isSameJob(
      { source: 'indeed', url: 'https://ie.indeed.com/viewjob?jk=first123', title: 'Software Engineer', company: 'Acme', location: 'Dublin' },
      { source: 'indeed', url: 'https://ie.indeed.com/viewjob?jk=second456', role: 'Software Engineer', company: 'Acme', location: 'Dublin' },
    )).toBe(false)
  })
})
