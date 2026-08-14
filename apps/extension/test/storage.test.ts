import { describe, expect, it } from 'vitest'
import { normalizeApiBaseUrl } from '../src/lib/storage'

describe('normalizeApiBaseUrl', () => {
  it('accepts the canonical HTTPS service', () => {
    expect(normalizeApiBaseUrl('https://applymate.site/')).toBe('https://applymate.site')
  })

  it('accepts only documented localhost development origins', () => {
    expect(normalizeApiBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000')
    expect(normalizeApiBaseUrl('http://localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeApiBaseUrl('http://localhost:8080')).toBeNull()
  })

  it('rejects HTTP, paths, credentials, and untrusted HTTPS origins', () => {
    expect(normalizeApiBaseUrl('http://applymate.site')).toBeNull()
    expect(normalizeApiBaseUrl('https://applymate.site/api')).toBeNull()
    expect(normalizeApiBaseUrl('https://user:pass@applymate.site')).toBeNull()
    expect(normalizeApiBaseUrl('https://example.com')).toBeNull()
  })
})
