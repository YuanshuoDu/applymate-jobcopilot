import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getDiscoveryApiAccess: vi.fn(),
  fetchCleanJobData: vi.fn(),
  pinnedFetch: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown) => Response.json(value),
  err: (message: string) => Response.json({ error: message }, { status: 400 }),
}))

vi.mock('@/lib/utils', () => ({ truncate: (value: string) => value, fmtSalary: vi.fn() }))
vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiAccess: mocks.getDiscoveryApiAccess }))
vi.mock('@/lib/agent/sources/cleanjobdata', () => ({ fetchCleanJobData: mocks.fetchCleanJobData }))
vi.mock('@jobcopilot/shared', () => ({ pinnedFetch: mocks.pinnedFetch, ATS_POLICIES: {} }))

import { cleanSearchTitle, postFilter, queryKeywords, scoreSearchJobs, smartDedup } from './search-quality'
import { GET } from './route'

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

describe('GET /api/search/unified CleanJobData routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.pinnedFetch.mockResolvedValue(new Response(null, { status: 503 }))
    mocks.fetchCleanJobData.mockResolvedValue([])
  })

  const access = (cleanJobDataApiKey: string) => ({
    rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey,
    rapidapiSource: 'none', adzunaSource: 'none',
  })

  function request(query = 'Software Engineer', location = 'Berlin'): NextRequest {
    const url = new URL('http://localhost/api/search/unified')
    url.searchParams.set('q', query)
    if (location) url.searchParams.set('location', location)
    url.searchParams.set('noCache', '1')
    return new NextRequest(url)
  }

  it('preserves existing routing when the platform key is absent', async () => {
    mocks.getDiscoveryApiAccess.mockResolvedValue(access(''))

    const response = await GET(request())
    const payload = await response.json()

    expect(mocks.fetchCleanJobData).not.toHaveBeenCalled()
    expect(payload.meta.sourcesUsed).not.toContain('cleanjobdata')
    expect(payload.meta.apiKeys.cleanjobdata).toBe(false)
  })

  it('keeps manual search working with public fallbacks when paid keys are absent', async () => {
    mocks.getDiscoveryApiAccess.mockResolvedValue(access(''))
    mocks.pinnedFetch.mockImplementation(async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://jobicy.com/')) {
        return new Response(JSON.stringify({ jobs: [{
          id: 1, url: 'https://jobicy.com/jobs/software-engineer', jobTitle: 'Software Engineer',
          companyName: 'Acme', jobType: ['Full Time'], jobGeo: 'Anywhere',
          jobExcerpt: 'Build software', pubDate: '2026-08-28T10:00:00.000Z',
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.startsWith('https://remotive.com/')) {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 503 })
    })

    const response = await GET(request('Software Engineer', ''))
    const payload = await response.json()
    const urls = mocks.pinnedFetch.mock.calls.map(([url]) => String(url))

    expect(payload.jobs).toHaveLength(1)
    expect(payload.jobs[0]).toMatchObject({ source: 'jobicy', title: 'Software Engineer' })
    expect(payload.meta.sourcesUsed).toContain('jobicy')
    expect(urls.some(url => url.startsWith('https://jobicy.com/') && new URL(url).searchParams.get('geo') === 'anywhere')).toBe(true)
    expect(urls.some(url => url.startsWith('https://remotive.com/'))).toBe(true)
  })

  it('routes, maps, deduplicates, and reports CleanJobData results', async () => {
    mocks.getDiscoveryApiAccess.mockResolvedValue(access('clean-key'))
    const base = {
      title: 'Software Engineer', company: 'Acme', location: 'Berlin, DE',
      url: 'https://jobs.example.com/1', description: 'Build reliable software', salary: null,
      logo: null, source: 'cleanjobdata', externalId: '1', postedAt: '2026-08-22T10:00:00.000Z',
      jobType: 'FULL_TIME', experienceLevel: 'SE', workArrangement: null, directApply: true as const,
    }
    mocks.fetchCleanJobData.mockResolvedValue([
      base,
      { ...base, externalId: 'duplicate', salary: 'EUR 80,000–90,000' },
    ])

    const response = await GET(request())
    const payload = await response.json()

    expect(mocks.fetchCleanJobData).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'clean-key', title: 'Software Engineer', countryCode: 'de', maxPages: 1, maxResults: 20,
    }))
    expect(payload.jobs).toHaveLength(1)
    expect(payload.jobs[0]).toMatchObject({ source: 'cleanjobdata', salary: 'EUR 80,000–90,000' })
    expect(payload.meta.sourcesUsed).toContain('cleanjobdata')
    expect(payload.meta.sourceBreakdown.cleanjobdata).toBe(1)
    expect(payload.meta.apiKeys.cleanjobdata).toBe(true)
  })

  it('uses the normalized company filter even when Mantiks is unavailable', async () => {
    mocks.getDiscoveryApiAccess.mockResolvedValue(access('clean-key'))

    await GET(request('jobs at Acme'))

    expect(mocks.fetchCleanJobData).toHaveBeenCalledWith(expect.objectContaining({
      title: '', companyName: 'Acme', countryCode: 'de',
    }))
  })

  it('annualizes hourly salary text before applying annual salary filters', () => {
    const hourly = job({ salary: 'EUR 50 per hour' })
    expect(postFilter([hourly], { ...baseFilters, salaryMin: 100_000 })).toHaveLength(1)
    expect(postFilter([hourly], { ...baseFilters, salaryMin: 110_000 })).toHaveLength(0)
  })
})
