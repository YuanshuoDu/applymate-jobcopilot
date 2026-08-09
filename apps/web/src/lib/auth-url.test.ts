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

  it('keeps preview authentication redirects on the preview host when requested', () => {
    expect(canonicalAuthRedirect('/login?callbackUrl=%2F', 'https://web-preview.vercel.app', undefined, true))
      .toBe('https://web-preview.vercel.app/login?callbackUrl=%2F')
  })

  it('does not allow an external preview redirect target', () => {
    expect(canonicalAuthRedirect('https://attacker.example/steal', 'https://web-preview.vercel.app', undefined, true))
      .toBe('https://web-preview.vercel.app/steal')
  })
})
