import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAuthSecret } from './auth-secret'

describe('auth secret configuration', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('permits a non-runtime secret only while Next builds production artifacts', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PHASE', 'phase-production-build')
    vi.stubEnv('AUTH_SECRET', '')

    expect(getAuthSecret()).toBe('build-time-auth-secret-not-for-runtime')
  })

  it('requires a configured secret in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PHASE', '')
    vi.stubEnv('AUTH_SECRET', '')
    vi.stubEnv('NEXTAUTH_SECRET', '')
    expect(getAuthSecret).toThrow('AUTH_SECRET or NEXTAUTH_SECRET must be configured')
  })

  it('supports the prior NEXTAUTH_SECRET deployment variable', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_SECRET', '')
    vi.stubEnv('NEXTAUTH_SECRET', 'legacy-production-secret')

    expect(getAuthSecret()).toBe('legacy-production-secret')
  })

  it('uses the configured value in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_SECRET', 'production-secret')
    vi.stubEnv('NEXTAUTH_SECRET', 'legacy-production-secret')
    expect(getAuthSecret()).toBe('production-secret')
  })
})
