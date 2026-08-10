import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import {
  clearOAuthStateCookie,
  getOAuthStateSecret,
  hasMatchingOAuthStateCookie,
  oauthStateCookieName,
  setOAuthStateCookie,
} from './oauth-state'

describe('OAuth state browser binding', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses an isolated, short-lived, HttpOnly cookie for each provider', () => {
    const response = NextResponse.json({ ok: true })
    setOAuthStateCookie(response, 'gmail', 'nonce-1')
    const cookie = response.cookies.get(oauthStateCookieName('gmail'))

    expect(cookie).toEqual(expect.objectContaining({
      value: 'nonce-1',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600,
      path: '/api/gmail/oauth',
    }))
    expect(oauthStateCookieName('github')).not.toBe(oauthStateCookieName('gmail'))
  })

  it('requires the matching nonce from the same provider cookie', () => {
    const request = new NextRequest('https://applymate.test/api/gmail/oauth/callback', {
      headers: { cookie: `${oauthStateCookieName('gmail')}=nonce-1` },
    })

    expect(hasMatchingOAuthStateCookie(request, 'gmail', 'nonce-1')).toBe(true)
    expect(hasMatchingOAuthStateCookie(request, 'gmail', 'wrong-nonce')).toBe(false)
    expect(hasMatchingOAuthStateCookie(request, 'github', 'nonce-1')).toBe(false)
  })

  it('clears the browser binding after the callback is consumed', () => {
    const response = NextResponse.json({ ok: true })
    clearOAuthStateCookie(response, 'github')
    const cookie = response.cookies.get(oauthStateCookieName('github'))

    expect(cookie).toEqual(expect.objectContaining({ value: '', maxAge: 0, path: '/api/github/oauth' }))
  })

  it('does not create OAuth state from the legacy fallback secret', () => {
    vi.stubEnv('AUTH_SECRET', '')

    expect(getOAuthStateSecret()).toBeNull()
  })
})
