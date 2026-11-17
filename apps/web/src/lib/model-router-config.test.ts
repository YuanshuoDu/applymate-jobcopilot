import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findUser: vi.fn(), decrypt: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUser } } }))
vi.mock('@/lib/ai-credential-settings', () => ({ decryptAiSettings: mocks.decrypt }))

import { loadUserAiSettings, resolveConfig, resolveFeatureConfig } from './model-router-config'

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('MINIMAX_API_KEY', '')
  vi.stubEnv('MINIMAX_BASE_URL', '')
  vi.stubEnv('MINIMAX_REGION', '')
  mocks.findUser.mockReset()
  mocks.decrypt.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('model-router config', () => {
  it('keeps provider curated endpoints while resolving the user credential source', () => {
    expect(resolveConfig({ provider: 'openai', model: 'gpt-5.5', apiBase: 'https://user.example/v1', apiKey: 'user-key' }))
      .toMatchObject({ provider: 'openai', model: 'gpt-5.5', apiBase: 'https://api.openai.com/v1', resolvedKey: 'user-key', credentialSource: 'user' })
  })

  it('merges the saved provider key into a feature config', () => {
    expect(resolveFeatureConfig('coverLetter', { features: { coverLetter: { provider: 'openai', model: 'gpt-5.5' } },
      keys: { openai: 'feature-user-key' } })).toMatchObject({ resolvedKey: 'feature-user-key', credentialSource: 'user' })
  })

  it('loads and decrypts settings through the existing user preference record', async () => {
    const settings = { features: { scoring: { provider: 'openai', model: 'gpt-5.5' } } }
    mocks.findUser.mockResolvedValue({ preferences: { aiSettings: { ciphertext: 'stored' } } })
    mocks.decrypt.mockResolvedValue(settings)

    await expect(loadUserAiSettings('user-1')).resolves.toBe(settings)
    expect(mocks.findUser).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: { preferences: true } })
    expect(mocks.decrypt).toHaveBeenCalledWith({ ciphertext: 'stored' }, 'user-1')
  })
})
