import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }))

vi.mock('@/lib/db', () => ({ db: { userApiKeys: { findUnique } } }))

import { getDiscoveryApiKeys } from './discovery-api-keys'

describe('getDiscoveryApiKeys', () => {
  beforeEach(() => {
    findUnique.mockReset()
    process.env.ADZUNA_APP_ID = 'platform-id'
    process.env.ADZUNA_APP_KEY = 'platform-key'
    process.env.RAPIDAPI_KEY = 'platform-rapid'
  })

  it('prefers a user’s saved keys to platform fallbacks', async () => {
    findUnique.mockResolvedValue({ adzunaAppId: ' user-id ', adzunaAppKey: ' user-key ', rapidapiKey: ' user-rapid ' })

    await expect(getDiscoveryApiKeys('user_1')).resolves.toEqual({
      adzunaAppId: 'user-id', adzunaAppKey: 'user-key', rapidapiKey: 'user-rapid',
    })
  })

  it('falls back to platform keys when no saved keys exist', async () => {
    findUnique.mockResolvedValue(null)

    await expect(getDiscoveryApiKeys('user_1')).resolves.toEqual({
      adzunaAppId: 'platform-id', adzunaAppKey: 'platform-key', rapidapiKey: 'platform-rapid',
    })
  })
})
