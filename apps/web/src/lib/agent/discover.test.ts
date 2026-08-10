import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDiscoveryApiKeys: vi.fn(),
  featureEnabled: vi.fn(),
}))

vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiKeys: mocks.getDiscoveryApiKeys }))
vi.mock('@/lib/runtime-feature-flags', () => ({ isRuntimeFeatureEnabled: mocks.featureEnabled }))

import { discoverJobs } from './discover'

describe('discoverJobs platform controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.featureEnabled.mockResolvedValue(false)
    mocks.getDiscoveryApiKeys.mockResolvedValue({
      rapidapiKey: 'rapidapi-key',
      adzunaAppId: 'adzuna-id',
      adzunaAppKey: 'adzuna-key',
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
})
