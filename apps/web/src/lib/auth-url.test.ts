import { describe, expect, it } from 'vitest'
import { canonicalAuthRedirect } from './auth-url'

describe('canonicalAuthRedirect', () => {
  it('moves Auth.js redirects from a Vercel preview host to the production host', () => {
    expect(canonicalAuthRedirect('/', 'https://web-delta-ruddy-29.vercel.app')).toBe('https://applymate.site/')
    expect(canonicalAuthRedirect('/?page=settings', 'https://web-delta-ruddy-29.vercel.app')).toBe('https://applymate.site/?page=settings')
  })

  it('does not rewrite a custom production host', () => {
    expect(canonicalAuthRedirect('/dashboard', 'https://applymate.site')).toBe('https://applymate.site/dashboard')
  })
})
