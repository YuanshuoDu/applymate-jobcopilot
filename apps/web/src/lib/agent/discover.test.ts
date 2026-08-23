import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDiscoveryApiKeys: vi.fn(),
  featureEnabled: vi.fn(),
  fetchCleanJobData: vi.fn(),
}))

vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiKeys: mocks.getDiscoveryApiKeys }))
vi.mock('@/lib/runtime-feature-flags', () => ({ isRuntimeFeatureEnabled: mocks.featureEnabled }))
vi.mock('./sources/cleanjobdata', () => ({ fetchCleanJobData: mocks.fetchCleanJobData }))

import { discoverJobs } from './discover'

describe('discoverJobs platform controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.featureEnabled.mockResolvedValue(false)
    mocks.getDiscoveryApiKeys.mockResolvedValue({
      rapidapiKey: 'rapidapi-key',
      adzunaAppId: 'adzuna-id',
      adzunaAppKey: 'adzuna-key',
      cleanJobDataApiKey: '',
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
})
