import { describe, expect, it } from 'vitest'
import { getJobIdentity } from '../src/lib/job-identity'

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
})
