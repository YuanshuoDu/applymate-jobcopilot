import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDiscoveryApiKeys: vi.fn(),
  featureEnabled: vi.fn(),
  fetchCleanJobData: vi.fn(),
  fetchFantasticJobs: vi.fn(),
}))

vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiKeys: mocks.getDiscoveryApiKeys }))
vi.mock('@/lib/runtime-feature-flags', () => ({ isRuntimeFeatureEnabled: mocks.featureEnabled }))
vi.mock('./sources/cleanjobdata', () => ({ fetchCleanJobData: mocks.fetchCleanJobData }))
vi.mock('./sources/fantasticjobs', () => ({ fetchFantasticJobs: mocks.fetchFantasticJobs }))

import { discoverJobs } from './discover'
import { clearDiscoveryCacheForTests } from '@/lib/discovery/cache'

describe('discoverJobs platform controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearDiscoveryCacheForTests()
    mocks.featureEnabled.mockResolvedValue(false)
    mocks.getDiscoveryApiKeys.mockResolvedValue({
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
    expect(mocks.getDiscoveryApiKeys).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('preserves the existing source path when CleanJobData is not configured', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiKeys.mockResolvedValue({
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
    mocks.getDiscoveryApiKeys.mockResolvedValue({
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
      apiKey: 'clean-key', title: 'Software Engineer', countryCode: 'de', maxPages: 1, maxResults: 5,
    })
    expect(jobs).toEqual([expect.objectContaining({ source: 'cleanjobdata', location: 'Berlin, Germany' })])
  })

  it('keeps Fantastic Jobs in Shadow and never returns them as visible discovery results', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiKeys.mockResolvedValue({
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
    mocks.getDiscoveryApiKeys.mockResolvedValue({
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
})
