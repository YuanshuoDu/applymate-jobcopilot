import { afterEach, describe, expect, it } from 'vitest'

import { platformIntegrationStatus, userIntegrationStatus } from './integration-status'

describe('admin integration status', () => {
  const original = { ...process.env }

  afterEach(() => {
    process.env = { ...original }
  })

  it('summarizes a user without returning credential values', () => {
    process.env.OPENAI_API_KEY = 'platform-secret'
    process.env.RAPIDAPI_KEY = 'platform-rapid'
    const status = userIntegrationStatus({
      preferences: {
        aiSettings: {
          keys: { openai: 'user-secret' },
          features: { scoring: { provider: 'openai', model: 'gpt-5.5' } },
        },
      },
      apiKeys: { rapidapiKey: 'user-rapid' },
      accountProviders: ['gmail'],
    })

    expect(status).toEqual(expect.objectContaining({
      accounts: { gmail: true, github: false },
      discovery: expect.objectContaining({ hasRapidapi: true, rapidapiSource: 'user' }),
      ai: expect.objectContaining({ featureOverrides: 1, customConfigured: false }),
    }))
    expect(JSON.stringify(status)).not.toContain('user-secret')
    expect(JSON.stringify(status)).not.toContain('user-rapid')
  })

  it('reports only boolean platform integration health', () => {
    process.env.MINIMAX_API_KEY = 'platform-secret'
    process.env.DATABASE_URL = 'postgres://user:password@example.test/db'
    const status = platformIntegrationStatus()

    expect(status.ai.providers.minimax).toBe(true)
    expect(status.infrastructure.database).toBe(true)
    expect(JSON.stringify(status)).not.toContain('password')
  })

  it('does not report a standard Google sign-in as a Gmail connection', () => {
    expect(userIntegrationStatus({
      accounts: [{ provider: 'google', scope: 'openid email profile' }],
    }).accounts.gmail).toBe(false)
    expect(userIntegrationStatus({
      accounts: [{ provider: 'google', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly' }],
    }).accounts.gmail).toBe(true)
    expect(userIntegrationStatus({
      accounts: [{ provider: 'gmail', scope: 'https://www.googleapis.com/auth/gmail.readonly' }],
    }).accounts.gmail).toBe(true)
  })

  it('does not expose custom endpoints as a platform credential option', () => {
    process.env.CUSTOM_API_KEY = 'platform-custom-secret'

    expect(platformIntegrationStatus().ai.providers.custom).toBe(false)
  })

  it('uses the OAuth environment names consumed by the actual callbacks', () => {
    process.env.AUTH_GOOGLE_ID = 'google-client'
    process.env.AUTH_GOOGLE_SECRET = 'google-secret'
    process.env.AUTH_GITHUB_ID = 'github-client'
    process.env.AUTH_GITHUB_SECRET = 'github-secret'
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
    delete process.env.GITHUB_CLIENT_ID
    delete process.env.GITHUB_CLIENT_SECRET

    const status = platformIntegrationStatus()

    expect(status.oauth).toEqual({ google: true, github: true })
  })
})
