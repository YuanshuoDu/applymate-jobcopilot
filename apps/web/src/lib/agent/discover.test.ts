import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDiscoveryApiAccess: vi.fn(),
  featureEnabled: vi.fn(),
  fetchCleanJobData: vi.fn(),
  fetchFantasticJobs: vi.fn(),
  trackedJobApiFetch: vi.fn(),
  reportJobApiJobs: vi.fn(),
}))

vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiAccess: mocks.getDiscoveryApiAccess }))
vi.mock('@/lib/runtime-feature-flags', () => ({ isRuntimeFeatureEnabled: mocks.featureEnabled }))
vi.mock('@/lib/api-usage/job-api-usage', () => ({ trackedJobApiFetch: mocks.trackedJobApiFetch, reportJobApiJobs: mocks.reportJobApiJobs }))
vi.mock('./sources/cleanjobdata', () => ({ fetchCleanJobData: mocks.fetchCleanJobData }))
vi.mock('./sources/fantasticjobs', () => ({ fetchFantasticJobs: mocks.fetchFantasticJobs }))

import { discoverJobs } from './discover'

describe('discoverJobs platform controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.featureEnabled.mockResolvedValue(false)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: 'rapidapi-key',
      adzunaAppId: 'adzuna-id',
      adzunaAppKey: 'adzuna-key',
      cleanJobDataApiKey: '',
      fantasticJobsApiKey: '',
      rapidapiSource: 'platform', adzunaSource: 'platform',
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
      rapidapiSource: 'platform', adzunaSource: 'platform',
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
      rapidapiSource: 'platform', adzunaSource: 'platform',
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
      apiKey: 'clean-key', title: 'Software Engineer', countryCode: 'de', maxPages: 1, maxResults: 5, userId: 'user-1',
    })
    expect(jobs).toEqual([expect.objectContaining({ source: 'cleanjobdata', location: 'Berlin, Germany' })])
  })

  it('adds Fantastic Jobs to the same location and result-cap pipeline', async () => {
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.getDiscoveryApiAccess.mockResolvedValue({
      rapidapiKey: '', adzunaAppId: '', adzunaAppKey: '', cleanJobDataApiKey: '', fantasticJobsApiKey: 'fantastic-key',
      rapidapiSource: 'platform', adzunaSource: 'platform',
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
    expect(jobs).toEqual([expect.objectContaining({ source: 'fantasticjobs', location: 'Berlin, Germany' })])
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
