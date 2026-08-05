import { describe, expect, it } from 'vitest'
import { applyAdminSecurityHeaders } from './http-security'

describe('admin HTTP security headers', () => {
  it('disables caching, embedding, sensitive browser permissions, and cross-origin referrals', () => {
    const response = applyAdminSecurityHeaders(new Response())
    expect(response.headers.get('Cache-Control')).toBe('no-store, private')
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})
