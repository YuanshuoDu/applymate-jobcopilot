import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pinnedFetch: vi.fn(), acquire: vi.fn() }))

vi.mock('@jobcopilot/shared', () => ({ pinnedFetch: mocks.pinnedFetch }))
vi.mock('../pace/policies', () => ({ acquire: mocks.acquire }))

import { fetchFantasticJobs } from './fantasticjobs'

describe('fetchFantasticJobs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the documented query and maps full job data', async () => {
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify([{
      id: 'fj-1', title: 'Platform Engineer', organization: { name: 'Acme', logo: 'https://cdn.example/logo.png' },
      url: 'https://jobs.example/fj-1', locations_derived: ['Berlin, Germany'], description_text: 'Build APIs.',
      date_posted: '2026-08-23T10:00:00Z', ai_salary_min: 70000, ai_salary_max: 90000,
      ai_salary_currency: 'EUR', ai_salary_unit: 'year', ai_employment_type: 'Full-time',
      ai_experience_level: 'Senior', ai_work_arrangement: 'Hybrid',
    }]), { status: 200 }))

    const jobs = await fetchFantasticJobs({ apiKey: 'secret', userId: 'u1', title: 'Engineer', location: 'Berlin, Germany', datePosted: 'week' })

    expect(jobs[0]).toMatchObject({ externalId: 'fj-1', company: 'Acme', description: 'Build APIs.', salary: 'EUR 70,000–90,000 / year', source: 'fantasticjobs', workArrangement: 'Hybrid' })
    const [url, init] = mocks.pinnedFetch.mock.calls[0] as [string, RequestInit]
    const params = new URL(url).searchParams
    expect(params.get('time_frame')).toBe('7d')
    expect(params.get('limit')).toBe('20')
    expect(params.get('description_format')).toBe('text')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret' })
    expect(mocks.acquire).toHaveBeenCalledWith({ ats: 'fantasticjobs' })
  })

  it('fails open when the key or response is unavailable', async () => {
    await expect(fetchFantasticJobs({ apiKey: ' ' })).resolves.toEqual([])
    mocks.pinnedFetch.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(fetchFantasticJobs({ apiKey: 'secret' })).resolves.toEqual([])
  })

  it('drops non-http application destinations before they can enter discovery', async () => {
    mocks.pinnedFetch.mockResolvedValue(new Response(JSON.stringify([
      { id: 'safe', title: 'Engineer', organization: { name: 'Acme' }, url: 'https://jobs.example/safe' },
      { id: 'unsafe', title: 'Engineer', organization: { name: 'Acme' }, url: 'javascript:alert(1)' },
    ]), { status: 200 }))

    const jobs = await fetchFantasticJobs({ apiKey: 'secret' })

    expect(jobs.map(job => job.externalId)).toEqual(['safe'])
  })
})
