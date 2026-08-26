import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDiscoveryApiAccess: vi.fn(),
  featureEnabled: vi.fn(),
  fetchCleanJobData: vi.fn(),
  fetchFantasticJobs: vi.fn(),
  loadProviderStates: vi.fn(),
  reserveProviderQuota: vi.fn(),
  trackedJobApiFetch: vi.fn((input: string | URL, init?: unknown) => globalThis.fetch(String(input), init as RequestInit)),
  reportJobApiJobs: vi.fn(),
}))

vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiAccess: mocks.getDiscoveryApiAccess }))
vi.mock('@/lib/runtime-feature-flags', () => ({ isRuntimeFeatureEnabled: mocks.featureEnabled }))
vi.mock('@/lib/api-usage/job-api-usage', () => ({ trackedJobApiFetch: mocks.trackedJobApiFetch, reportJobApiJobs: mocks.reportJobApiJobs }))
vi.mock('@/lib/discovery/quota', () => ({
  loadProviderStates: mocks.loadProviderStates,
  reserveProviderQuota: mocks.reserveProviderQuota,
}))
vi.mock('./sources/cleanjobdata', () => ({ fetchCleanJobData: mocks.fetchCleanJobData }))
vi.mock('./sources/fantasticjobs', () => ({ fetchFantasticJobs: mocks.fetchFantasticJobs }))

import { discoverJobs } from './discover'
import { clearDiscoveryCacheForTests } from '@/lib/discovery/cache'

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

  it('records legacy discovery API calls with the requesting user', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key', adzunaAppId: 'adzuna-id', adzunaAppKey: 'adzuna-key',
      cleanJobDataApiKey: '', fantasticJobsApiKey: '', rapidapiSource: 'user', adzunaSource: 'user',
    })
    mocks.trackedJobApiFetch.mockImplementation(() => Promise.resolve(new Response('[]', { status: 200 })))

    await expect(discoverJobs({
      userId: 'user-1', targetRoles: ['Engineer'], targetLocations: ['Berlin'],
      existingUrls: new Set(), maxResults: 5,
    })).resolves.toEqual([])

    expect(mocks.trackedJobApiFetch).toHaveBeenCalledTimes(3)
    expect(mocks.trackedJobApiFetch.mock.calls.map((call: unknown[]) => call[2])).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'rapidapi-active-jobs', userId: 'user-1', credentialSource: 'user' }),
      expect.objectContaining({ provider: 'rapidapi-linkedin', userId: 'user-1', credentialSource: 'user' }),
      expect.objectContaining({ provider: 'adzuna', userId: 'user-1', credentialSource: 'user' }),
    ]))
    expect(mocks.reportJobApiJobs).toHaveBeenCalledTimes(3)
  })
})
