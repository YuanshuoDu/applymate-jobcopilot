import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAuthSecret } from './auth-secret'

describe('auth secret configuration', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('requires a configured secret in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_SECRET', '')
    expect(getAuthSecret).toThrow('AUTH_SECRET must be configured')
  })
  it('uses the configured value in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_SECRET', 'production-secret')
    expect(getAuthSecret()).toBe('production-secret')
  })
})
