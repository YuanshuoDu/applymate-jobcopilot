import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: vi.fn(), isErrorResponse: vi.fn(), ok: vi.fn(), err: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({ truncate: (value: string) => value, fmtSalary: vi.fn() }))

import { cleanSearchTitle, postFilter, queryKeywords, scoreSearchJobs, smartDedup } from './search-quality'

type SearchJob = Parameters<typeof postFilter>[0][number]

function job(overrides: Partial<SearchJob>): SearchJob {
  return {
    id: 'job_1', title: 'UI Designer', company: 'Acme', location: 'Dublin, Ireland',
    description: '', url: 'https://example.com/jobs/1', source: 'linkedin', score: 0,
    ...overrides,
  }
}

const baseFilters = {
  location: '', remote: false, jobType: '', datePosted: 'any', experience: '',
}

describe('unified search precision', () => {
  it('keeps a city search from returning a different city', () => {
    const results = postFilter([
      job({ id: 'dublin', location: 'Dublin, Ireland' }),
      job({ id: 'london', location: 'London, United Kingdom' }),
      job({ id: 'remote', location: 'Worldwide remote' }),
    ], { ...baseFilters, location: 'Dublin' })

    expect(results.map(result => result.id)).toEqual(['dublin'])
  })

  it('preserves distinct junior and senior openings at the same company', () => {
    const results = smartDedup([
      job({ id: 'junior', title: 'Junior UX Designer', url: 'https://example.com/jobs/junior' }),
      job({ id: 'senior', title: 'Senior UX Designer', url: 'https://example.com/jobs/senior' }),
    ])

    expect(results.map(result => result.id)).toEqual(['junior', 'senior'])
  })

  it('keeps short role acronyms such as UI and UX in the query signal', () => {
    expect(cleanSearchTitle('Senior UI UX Designer')).toBe('UI UX Designer')
    expect(queryKeywords('UI UX Designer')).toEqual(['ui', 'ux', 'designer'])
  })

  it('ranks a title match above an unrelated fresh result', () => {
    const results = scoreSearchJobs([
      job({ id: 'match', title: 'UI UX Designer', location: 'London', source: 'ats', postedAt: '2026-06-01' }),
      job({ id: 'fresh-unrelated', title: 'Backend Engineer', location: 'London', source: 'linkedin', postedAt: new Date().toISOString() }),
    ], 'UI UX Designer', { ...baseFilters, location: 'London' })

    expect(results.sort((a, b) => b.score - a.score).map(result => result.id)).toEqual(['match', 'fresh-unrelated'])
  })
})
