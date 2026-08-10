import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredAppOrigin, configuredRedirectUri } from './app-url'

describe('configured app URLs', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses the configured public origin instead of a proxy or preview request host', () => {
    vi.stubEnv('AUTH_URL', 'https://applymate.site/some-path')
    vi.stubEnv('NEXTAUTH_URL', 'https://old.example')
    expect(configuredAppOrigin('https://preview.vercel.app/api/callback')).toBe('https://applymate.site')
    expect(configuredRedirectUri('https://preview.vercel.app/api/callback', '/api/gmail/oauth/callback')).toBe(
      'https://applymate.site/api/gmail/oauth/callback',
    )
  })

  it('falls back to the request origin when no public URL is configured', () => {
    expect(configuredRedirectUri('http://localhost:3000/api/callback', '/api/gmail/oauth/callback')).toBe(
      'http://localhost:3000/api/gmail/oauth/callback',
    )
  })

  it('ignores malformed configured URLs rather than throwing from an OAuth route', () => {
    vi.stubEnv('AUTH_URL', 'not a URL')
    expect(configuredAppOrigin('http://localhost:3000/api/callback')).toBe('http://localhost:3000')
  })

  it('uses the canonical production origin when deployment URL configuration is missing', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_URL', 'not a URL')
    vi.stubEnv('NEXTAUTH_URL', '')
    vi.stubEnv('APP_URL', '')
    vi.stubEnv('AUTH_CANONICAL_URL', '')
    expect(configuredAppOrigin('https://attacker.example/api/callback')).toBe('https://applymate.site')
  })
})
