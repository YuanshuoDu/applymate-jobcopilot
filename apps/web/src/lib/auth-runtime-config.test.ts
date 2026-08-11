import { describe, expect, it } from 'vitest'
import { assertNoAuthOriginOverride, authOriginOverrideError } from './auth-runtime-config'

describe('Auth.js runtime origin configuration', () => {
  it('allows a local single-origin development configuration', () => {
    expect(authOriginOverrideError({ AUTH_URL: 'http://localhost:3000' })).toBeNull()
  })

  it('rejects global Auth.js URL overrides on a Vercel deployment', () => {
    const environment = { VERCEL_ENV: 'production', AUTH_URL: 'https://applymate.site', NEXTAUTH_URL: 'https://applymate.site' }
    expect(authOriginOverrideError(environment)).toContain('AUTH_URL and NEXTAUTH_URL')
    expect(() => assertNoAuthOriginOverride(environment)).toThrow('request host')
  })
})
