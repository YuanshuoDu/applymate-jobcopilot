import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pinnedFetch: vi.fn(), acquire: vi.fn() }))

vi.mock('@jobcopilot/shared', () => ({ pinnedFetch: mocks.pinnedFetch }))
vi.mock('../pace/policies', () => ({ acquire: mocks.acquire }))

import { fetchCleanJobData } from './cleanjobdata'

function response(data: unknown, nextPage: string | null = null, status = 200): Response {
  return new Response(JSON.stringify({ data, pagination: { limit: 20, next_page: nextPage } }), { status })
}

function providerJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    title: 'Senior Software Engineer',
    location: 'Berlin, Germany',
    locations: [{ display_label: 'Berlin, DE', is_primary: true }],
    application_url: 'https://jobs.example.com/123',
    published: '2026-08-22T10:00:00.000Z',
    description: '<p>Build <strong>reliable</strong> systems &amp; APIs.</p>',
    has_remote: true,
    remote_type: 'fully_remote',
    employment_type: 'FULL_TIME',
    experience_level: 'SE',
    salary_min: 70000,
    salary_max: 90000,
    salary_currency: 'EUR',
    salary_text: null,
    company: { name: 'Acme GmbH', logo: 'https://cdn.example.com/acme.png' },
    ...overrides,
  }
}

describe('fetchCleanJobData', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps normalized jobs and sends supported filters with a server key', async () => {
    mocks.pinnedFetch.mockResolvedValue(response([providerJob()]))

    const jobs = await fetchCleanJobData({
      apiKey: ' secret ', title: 'Software Engineer', countryCode: 'de', remote: true,
      datePosted: 'week', experience: 'senior', jobType: 'fulltime',
      salaryMin: 70_000, salaryMax: 100_000,
    })

    expect(jobs).toEqual([expect.objectContaining({
      externalId: '123', title: 'Senior Software Engineer', company: 'Acme GmbH',
      location: 'Remote · Berlin, DE', url: 'https://jobs.example.com/123',
      description: 'Build reliable systems & APIs.', salary: 'EUR 70,000–90,000',
      source: 'cleanjobdata', postedAt: '2026-08-22T10:00:00.000Z',
      jobType: 'FULL_TIME', experienceLevel: 'SE', workArrangement: 'Remote Solely', directApply: true,
    })])
    const [url, init] = mocks.pinnedFetch.mock.calls[0] as [string, RequestInit]
    const params = new URL(url).searchParams
    expect(init.headers).toMatchObject({ 'x-api-key': 'secret' })
    expect(params.get('extra_fields')).toBe('description')
    expect(params.get('location')).toBe('DE')
    expect(params.get('remote')).toBe('true')
    expect(params.get('max_age')).toBe('7d')
    expect(params.get('experience_level')).toBe('SE')
    expect(params.get('employment_type')).toBe('FULL_TIME')
    expect(params.get('salary')).toBe('70000,100000')
    expect(mocks.acquire).toHaveBeenCalledWith({ ats: 'cleanjobdata' })
  })

  it('follows opaque cursors but respects the requested result ceiling', async () => {
    mocks.pinnedFetch
      .mockResolvedValueOnce(response([providerJob({ id: 1 })], 'next-token'))
      .mockResolvedValueOnce(response([providerJob({ id: 2, application_url: 'https://jobs.example.com/2' })]))

    const jobs = await fetchCleanJobData({ apiKey: 'key', title: 'Engineer', maxPages: 3, maxResults: 2 })

    expect(jobs.map(job => job.externalId)).toEqual(['1', '2'])
    expect(new URL(mocks.pinnedFetch.mock.calls[1][0] as string).searchParams.get('cursor')).toBe('next-token')
    expect(mocks.pinnedFetch).toHaveBeenCalledTimes(2)
  })

  it('caps provider pagination even when a caller requests more pages', async () => {
    mocks.pinnedFetch.mockImplementation(() => Promise.resolve(response([providerJob()], 'next-token')))

    await fetchCleanJobData({ apiKey: 'key', title: 'Engineer', maxPages: 99, maxResults: 60 })

    expect(mocks.pinnedFetch).toHaveBeenCalledTimes(3)
  })

  it('does not call the provider when the platform key is missing', async () => {
    await expect(fetchCleanJobData({ apiKey: ' ', title: 'Engineer' })).resolves.toEqual([])
    expect(mocks.pinnedFetch).not.toHaveBeenCalled()
  })

  it.each([401, 429, 503])('fails open on HTTP %s', async status => {
    mocks.pinnedFetch.mockResolvedValue(new Response(null, { status }))
    await expect(fetchCleanJobData({ apiKey: 'key', title: 'Engineer' })).resolves.toEqual([])
  })

  it('fails open on malformed JSON shapes', async () => {
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    await expect(fetchCleanJobData({ apiKey: 'key', title: 'Engineer' })).resolves.toEqual([])
  })

  it('fails open on network errors and timeouts', async () => {
    mocks.pinnedFetch.mockRejectedValue(new DOMException('Timed out', 'AbortError'))
    await expect(fetchCleanJobData({ apiKey: 'key', title: 'Engineer' })).resolves.toEqual([])
  })

  it('drops records without a company or valid direct application URL', async () => {
    mocks.pinnedFetch.mockResolvedValue(response([
      providerJob({ company: null }),
      providerJob({ id: 2, application_url: 'javascript:alert(1)' }),
    ]))
    await expect(fetchCleanJobData({ apiKey: 'key', title: 'Engineer' })).resolves.toEqual([])
  })
})
