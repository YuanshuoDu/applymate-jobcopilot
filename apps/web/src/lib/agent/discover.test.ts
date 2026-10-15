import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDiscoveryApiAccess: vi.fn(),
  featureEnabled: vi.fn(),
  fetchCleanJobData: vi.fn(),
  fetchFantasticJobs: vi.fn(),
  loadProviderStates: vi.fn(),
  reserveProviderQuota: vi.fn(),
  pinnedFetch: vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)),
}))

vi.mock('@jobcopilot/shared', () => ({ pinnedFetch: mocks.pinnedFetch }))
vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiAccess: mocks.getDiscoveryApiAccess }))
vi.mock('@/lib/runtime-feature-flags', () => ({ isRuntimeFeatureEnabled: mocks.featureEnabled }))
vi.mock('@/lib/discovery/quota', () => ({
  loadProviderStates: mocks.loadProviderStates,
  reserveProviderQuota: mocks.reserveProviderQuota,
}))
vi.mock('./sources/cleanjobdata', () => ({ fetchCleanJobData: mocks.fetchCleanJobData }))
vi.mock('./sources/fantasticjobs', () => ({ fetchFantasticJobs: mocks.fetchFantasticJobs }))

import { discoverJobs } from './discover'
import { clearDiscoveryCacheForTests, createDiscoveryCacheKey, credentialCacheScope, setDiscoveryCache } from '@/lib/discovery/cache'

function mockProviderResponses() {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input)
    if (url.includes('api.adzuna.com')) {
      return Promise.resolve(new Response(JSON.stringify({ results: [{
        title: 'Engineer', company: { display_name: 'Acme' }, location: { display_name: 'Berlin' },
        redirect_url: 'https://jobs.example.com/adzuna', description: 'Adzuna listing',
      }] })))
    }
    if (url.includes('linkedin-job-search-api')) {
      return Promise.resolve(new Response(JSON.stringify([{
        title: 'Engineer', organization: 'Acme', url: 'https://jobs.example.com/linkedin',
        locations_derived: ['Berlin'], description_text: 'LinkedIn listing',
      }])))
    }
    if (url.includes('active-jobs-db')) return Promise.resolve(new Response(JSON.stringify([])))
    return Promise.resolve(new Response('<rss><channel></channel></rss>'))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('discoverJobs platform controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearDiscoveryCacheForTests()
    mocks.featureEnabled.mockResolvedValue(false)
    mocks.loadProviderStates.mockImplementation(async (providers: string[]) => new Map(providers.map(provider => [provider, {
      quotaBand: 'green', circuitOpen: false, recentErrorRate: 0, remainingRatio: 1,
    }])))
    mocks.reserveProviderQuota.mockResolvedValue({ settle: async () => undefined })
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key',
      adzunaAppId: 'adzuna-id',
      adzunaAppKey: 'adzuna-key',
      cleanJobDataApiKey: '',
      fantasticJobsApiKey: '',
    })
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => vi.unstubAllGlobals())

  it('does not fetch jobs from any caller when worker discovery is disabled', async () => {
    await expect(discoverJobs({
      userId: 'user-1',
      targetRoles: ['Engineer'],
      targetLocations: ['Dublin'],
      existingUrls: new Set(),
      maxResults: 5,
    })).resolves.toEqual([])

    expect(mocks.featureEnabled).toHaveBeenCalledWith('worker_discovery', 'user-1')
    expect(mocks.getDiscoveryApiAccess).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('preserves the existing source path when CleanJobData is not configured', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '',
      fantasticJobsApiKey: '',
    })

    await expect(discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 5,
    })).resolves.toEqual([])

    expect(mocks.fetchCleanJobData).not.toHaveBeenCalled()
  })

  it('adds CleanJobData jobs to the existing location and result-cap pipeline', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: 'clean-key',
      fantasticJobsApiKey: '',
    })
    mocks.fetchCleanJobData.mockResolvedValue([{
      title: 'Software Engineer', company: 'Acme', location: 'Berlin, Germany',
      url: 'https://jobs.example.com/1', description: 'Build software', salary: null,
      logo: null, source: 'cleanjobdata',
    }])

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Software Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 5,
    })

    expect(mocks.fetchCleanJobData).toHaveBeenCalledWith({
      apiKey: 'clean-key', userId: 'user-1', title: 'Software Engineer', countryCode: 'de', maxPages: 1, maxResults: 5,
    })
    expect((mocks.fetchCleanJobData.mock.calls[0]?.[0] as { onProviderFailure?: unknown }).onProviderFailure).toBeUndefined()
    expect(jobs).toEqual([expect.objectContaining({ source: 'cleanjobdata', location: 'Berlin, Germany' })])
  })

  it('keeps Fantastic Jobs in Shadow and never returns them as visible discovery results', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: 'fantastic-key',
    })
    mocks.fetchFantasticJobs.mockResolvedValue([{
      title: 'Platform Engineer', company: 'Acme', location: 'Berlin, Germany',
      url: 'https://jobs.example.com/fj-1', description: 'Build APIs', salary: null,
      logo: null, source: 'fantasticjobs', externalId: 'fj-1', postedAt: null,
      jobType: null, experienceLevel: null, workArrangement: null,
    }])

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Platform Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 5,
    })

    expect(mocks.fetchFantasticJobs).toHaveBeenCalledWith({
      apiKey: 'fantastic-key', title: 'Platform Engineer', location: 'Berlin', userId: 'user-1',
    })
    expect(jobs).toEqual([])
    expect(mocks.featureEnabled).toHaveBeenCalledWith('fantasticjobs_shadow', 'user-1')
    expect((mocks.fetchFantasticJobs.mock.calls[0]?.[0] as { onProviderFailure?: unknown }).onProviderFailure).toBeUndefined()
  })

  it('shares concurrent Scout requests through the discovery Singleflight', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: 'clean-key',
      fantasticJobsApiKey: '',
    })
    mocks.fetchCleanJobData.mockResolvedValue([{
      title: 'Software Engineer', company: 'Acme', location: 'Berlin, Germany',
      url: 'https://jobs.example.com/1', description: 'Build software', salary: null,
      logo: null, source: 'cleanjobdata',
    }])
    const params = {
      userId: 'user-1', targetRoles: ['Software Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set<string>(), maxResults: 5,
    }

    const [first, second] = await Promise.all([discoverJobs(params), discoverJobs(params)])

    expect(mocks.fetchCleanJobData).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })

  it('keeps paid providers out when the free IrishJobs result target is met', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '',
      fantasticJobsApiKey: '', adzunaSource: 'none', rapidapiSource: 'platform',
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      '<rss><item><title>Software Engineer</title><link>https://jobs.example.com/irish-1</link><description>Company: Acme | Location: Dublin</description></item></rss>',
      { status: 200, headers: { 'content-type': 'application/rss+xml' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Software Engineer'], targetLocations: ['Dublin'],
      existingUrls: new Set(), maxResults: 1,
    })

    expect(jobs).toHaveLength(1)
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('rapidapi'))).toBe(true)
    expect(mocks.reserveProviderQuota.mock.calls.every(([call]) => (call as { provider: string }).provider === 'irishjobs')).toBe(true)
  })

  it('falls through to RapidAPI when a platform provider reservation is denied', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: 'clean-key',
      fantasticJobsApiKey: '', adzunaSource: 'none', rapidapiSource: 'platform',
    })
    mocks.fetchCleanJobData.mockResolvedValue([])
    mocks.reserveProviderQuota.mockImplementation(async (call: { provider: string }) => call.provider === 'cleanjobdata'
      ? null
      : { settle: async () => undefined })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await discoverJobs({
      userId: 'user-1', targetRoles: ['Software Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 1,
    })

    const reservedProviders = mocks.reserveProviderQuota.mock.calls.map(([call]) => (call as { provider: string }).provider)
    expect(reservedProviders[0]).toBe('cleanjobdata')
    expect(reservedProviders).toContain('rapidapi-linkedin')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('filters the provider plan by source before another provider fills the result cap', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    const fetchMock = mockProviderResponses()

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'], source: 'linkedin',
      existingUrls: new Set(), maxResults: 1,
    })

    expect(jobs.map(job => job.source)).toEqual(['linkedin'])
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('linkedin-job-search-api'),
    ])
    expect(mocks.reserveProviderQuota.mock.calls.map(([call]) => (call as { provider: string }).provider)).toEqual(['rapidapi-linkedin'])
  })

  it('skips Fantastic Jobs shadow calls when another source is explicitly selected', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '',
      fantasticJobsApiKey: 'fantastic-key',
    })
    const fetchMock = mockProviderResponses()

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'], source: 'linkedin',
      existingUrls: new Set(), maxResults: 5,
    })

    expect(jobs.map(job => job.source)).toEqual(['linkedin'])
    expect(mocks.fetchFantasticJobs).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([expect.stringContaining('linkedin-job-search-api')])
    expect(mocks.reserveProviderQuota.mock.calls.map(([call]) => (call as { provider: string }).provider)).toEqual(['rapidapi-linkedin'])
  })

  it('allows Fantastic Jobs shadow calls when FantasticJobs itself is selected', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '',
      fantasticJobsApiKey: 'fantastic-key',
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'], source: 'FantasticJobs',
      existingUrls: new Set(), maxResults: 5,
    })

    expect(jobs).toEqual([])
    expect(mocks.fetchFantasticJobs).toHaveBeenCalledOnce()
    expect(mocks.reserveProviderQuota.mock.calls.map(([call]) => (call as { provider: string }).provider)).toEqual(['fantasticjobs'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('separates cached candidate windows by requested source', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    const fetchMock = mockProviderResponses()
    const base = {
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set<string>(), maxResults: 1,
    }

    const linkedin = await discoverJobs({ ...base, source: 'linkedin' })
    const adzuna = await discoverJobs({ ...base, source: 'adzuna' })

    expect(linkedin.map(job => job.source)).toEqual(['linkedin'])
    expect(adzuna.map(job => job.source)).toEqual(['adzuna'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves no-source provider priority and ignores the previous worker cache version', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    const fetchMock = mockProviderResponses()
    const credentialScope = credentialCacheScope({ userId: 'user-1', providerScopes: { worker: 'user' } })
    const legacyKey = createDiscoveryCacheKey({
      query: { roles: 'engineer', locations: 'berlin', existingUrls: '', maxResults: 1, fantasticShadow: false },
      providers: ['worker-discovery-v1'],
      credentialScope,
    })
    await setDiscoveryCache(legacyKey, [{
      title: 'Stale Engineer', company: 'Old', location: 'Berlin', url: 'https://jobs.example.com/stale',
      description: '', salary: null, logo: null, source: 'linkedin',
    }])

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 1,
    })

    expect(jobs.map(job => job.source)).toEqual(['adzuna'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('api.adzuna.com')
  })

  it('reports one inline provider error for a handled non-OK response', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: '',
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })))
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })

    expect(events).toEqual([expect.objectContaining({ provider: 'irishjobs', status: 'error', jobsReturned: 0 })])
  })

  it('reports one inline provider error for a caught network failure', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: '',
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')))
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })

    expect(events).toEqual([expect.objectContaining({ provider: 'irishjobs', status: 'error', jobsReturned: 0 })])
  })

  it.each(['throws synchronously', 'rejects asynchronously'] as const)(
    'keeps provider results when the telemetry observer %s',
    async behavior => {
      mocks.featureEnabled.mockResolvedValue(true)
      mocks.getDiscoveryApiAccess.mockResolvedValue({
        rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: '',
      })
      const rss = '<rss><channel><item><title>Engineer</title><link>https://jobs.example.com/engineer</link><description>Company: Acme | Location: Dublin</description></item></channel></rss>'
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(rss)))
      const onProviderCall = vi.fn(() => {
        if (behavior === 'throws synchronously') throw new Error('observer failed')
        return Promise.reject(new Error('observer failed'))
      })

      const jobs = await discoverJobs({
        userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
        existingUrls: new Set(), maxResults: 5, onProviderCall,
      })

      expect(jobs.map(job => job.title)).toEqual(['Engineer'])
      expect(onProviderCall).toHaveBeenCalledTimes(1)
      expect(onProviderCall).toHaveBeenCalledWith(expect.objectContaining({ provider: 'irishjobs', status: 'success', jobsReturned: 1 }))
    },
  )

  it('reports malformed IrishJobs rows once while retaining valid partial results', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: '',
    })
    const rss = `<rss><channel>
      <item><title>Engineer</title><link>https://jobs.example.com/valid</link><description>Company: Acme | Location: Dublin</description></item>
      <item><title></title><link>https://jobs.example.com/missing-title</link><description>Company: Acme | Location: Dublin</description></item>
      <item><title>Missing link</title><link></link><description>Company: Acme | Location: Dublin</description></item>
    </channel></rss>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(rss)))
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })

    expect(jobs.map(job => job.title)).toEqual(['Engineer'])
    expect(events).toEqual([expect.objectContaining({ provider: 'irishjobs', status: 'error', jobsReturned: 1 })])
  })

  it('keeps a valid empty inline response successful', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: '',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('<rss><channel></channel></rss>', { status: 200 }))))
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    await expect(discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })).resolves.toEqual([])

    expect(events).toEqual([expect.objectContaining({ provider: 'irishjobs', status: 'success', jobsReturned: 0 })])
  })

  it('keeps a valid empty provider array successful', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: '',
    })
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input)
      if (url.includes('linkedin-job-search-api') || url.includes('active-jobs-db')) {
        return Promise.resolve(new Response(JSON.stringify([])))
      }
      return Promise.resolve(new Response('<rss><channel></channel></rss>'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    await expect(discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })).resolves.toEqual([])

    expect(events.filter(event => event.provider === 'rapidapi-linkedin')).toEqual([
      expect.objectContaining({ status: 'success', jobsReturned: 0 }),
    ])
  })

  it('reports malformed provider items once and retains valid partial jobs', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: '',
    })
    const linkedinJobs = [
      { title: 'Valid Engineer', organization: 'Acme', url: 'https://jobs.example.com/linkedin-valid', locations_derived: ['Dublin'], description_text: 'Valid listing' },
      { organization: 'Missing title', url: 'https://jobs.example.com/linkedin-no-title', locations_derived: ['Dublin'] },
      { title: 'Missing company', url: 'https://jobs.example.com/linkedin-no-company', locations_derived: ['Dublin'] },
    ]
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input)
      if (url.includes('linkedin-job-search-api')) return Promise.resolve(new Response(JSON.stringify(linkedinJobs)))
      if (url.includes('jobs-api14')) return Promise.resolve(new Response(JSON.stringify({ data: [] })))
      if (url.includes('active-jobs-db')) return Promise.resolve(new Response(JSON.stringify([])))
      return Promise.resolve(new Response('<rss><channel></channel></rss>'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })

    expect(jobs.map(job => job.title)).toEqual(['Valid Engineer'])
    expect(events.filter(event => event.provider === 'rapidapi-linkedin')).toEqual([
      expect.objectContaining({ status: 'error', jobsReturned: 3 }),
    ])
  })

  it('preserves the empty fallback when a provider array contains a null row', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: '',
    })
    const linkedinJobs = [
      { title: 'Valid Engineer', organization: 'Acme', url: 'https://jobs.example.com/linkedin-valid', locations_derived: ['Dublin'], description_text: 'Valid listing' },
      null,
    ]
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input)
      if (url.includes('linkedin-job-search-api')) return Promise.resolve(new Response(JSON.stringify(linkedinJobs)))
      if (url.includes('active-jobs-db')) return Promise.resolve(new Response(JSON.stringify([])))
      if (url.includes('jsearch.p.rapidapi.com')) return Promise.resolve(new Response(JSON.stringify({ data: { jobs: [] } })))
      return Promise.resolve(new Response('<rss><channel></channel></rss>'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Dublin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })

    expect(jobs).toEqual([])
    expect(events.filter(event => event.provider === 'rapidapi-linkedin')).toEqual([
      expect.objectContaining({ status: 'error', jobsReturned: 0 }),
    ])
  })

  it('reports helper failures once while preserving CleanJobData partial results', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: 'clean-key', fantasticJobsApiKey: '',
    })
    mocks.fetchCleanJobData.mockImplementation(async (query: { onProviderFailure?: () => void }) => {
      query.onProviderFailure?.()
      query.onProviderFailure?.()
      return [{
        title: 'Engineer', company: 'Acme', location: 'Berlin, Germany', url: 'https://jobs.example.com/partial',
        description: 'Build software', salary: null, logo: null, source: 'cleanjobdata',
      }]
    })
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    const jobs = await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })

    expect(jobs).toHaveLength(1)
    expect(events).toEqual([expect.objectContaining({ provider: 'cleanjobdata', status: 'error', jobsReturned: 1 })])
  })

  it('includes a configured Fantastic Jobs shadow failure once in provider telemetry', async () => {
    mocks.featureEnabled.mockImplementation(async flag => flag === 'worker_discovery' || flag === 'fantasticjobs_shadow')
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: 'fantastic-key',
    })
    mocks.fetchFantasticJobs.mockImplementation(async (query: { onProviderFailure?: () => void }) => {
      query.onProviderFailure?.()
      query.onProviderFailure?.()
      return []
    })
    const events: Array<{ provider: string; status: string; jobsReturned: number }> = []

    await discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 5, onProviderCall: event => { events.push(event) },
    })

    expect(events).toEqual([expect.objectContaining({ provider: 'fantasticjobs', status: 'error', jobsReturned: 0 })])
  })
})
