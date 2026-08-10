import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }))

vi.mock('@/lib/db', () => ({ db: { userApiKeys: { findUnique } } }))

import {
  DISCOVERY_KEY_ERROR_MESSAGES,
  getDiscoveryApiKeyStatus,
  getDiscoveryApiKeys,
} from './discovery-api-keys'

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

  it('does not mix a partial user Adzuna pair with platform credentials', async () => {
    findUnique.mockResolvedValue({ adzunaAppId: 'user-id', adzunaAppKey: null, rapidapiKey: null })

    await expect(getDiscoveryApiKeys('user_1')).resolves.toEqual({
      adzunaAppId: 'user-id', adzunaAppKey: '', rapidapiKey: 'platform-rapid',
    })
  })

  it('reports effective source and incomplete pair state without exposing values', async () => {
    findUnique.mockResolvedValue({ adzunaAppId: 'user-id', adzunaAppKey: null, rapidapiKey: 'user-rapid' })

    await expect(getDiscoveryApiKeyStatus('user_1')).resolves.toEqual({
      hasAdzuna: false,
      hasRapidapi: true,
      userHasAdzuna: true,
      userHasRapidapi: true,
      adzunaSource: 'incomplete',
      rapidapiSource: 'user',
      needsAdzunaPair: true,
    })
  })

  it('keeps missing-credential guidance in one Settings-focused contract', () => {
    expect(DISCOVERY_KEY_ERROR_MESSAGES.rapidapi).toContain('Settings')
    expect(DISCOVERY_KEY_ERROR_MESSAGES.rapidapi).not.toContain('RAPIDAPI_KEY')
    expect(DISCOVERY_KEY_ERROR_MESSAGES.adzuna).toContain('Settings')
  })
})
