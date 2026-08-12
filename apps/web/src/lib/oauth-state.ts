import { NextRequest, NextResponse } from 'next/server'

export type OAuthStateProvider = 'github' | 'gmail'

const STATE_COOKIE_MAX_AGE = 10 * 60

export function getOAuthStateSecret(): Uint8Array | null {
  const secret = process.env.AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim()
  if (
    !secret ||
    secret === 'fallback-secret-change-this' ||
    secret === 'development-only-auth-secret'
  ) {
    return null
  }
  return new TextEncoder().encode(secret)
}

export function oauthStateCookieName(provider: OAuthStateProvider): string {
  return `applymate-${provider}-oauth-state`
}

export function setOAuthStateCookie(
  response: NextResponse,
  provider: OAuthStateProvider,
  nonce: string,
): void {
  response.cookies.set(oauthStateCookieName(provider), nonce, stateCookieOptions(provider))
}

export function clearOAuthStateCookie(response: NextResponse, provider: OAuthStateProvider): void {
  response.cookies.set(oauthStateCookieName(provider), '', {
    ...stateCookieOptions(provider),
    expires: new Date(0),
    maxAge: 0,
  })
}

export function hasMatchingOAuthStateCookie(
  request: NextRequest,
  provider: OAuthStateProvider,
  nonce: string,
): boolean {
  const cookieNonce = request.cookies.get(oauthStateCookieName(provider))?.value
  return typeof cookieNonce === 'string' && constantTimeEqual(cookieNonce, nonce)
}

function stateCookieOptions(provider: OAuthStateProvider) {
  return {
    httpOnly: true,
    maxAge: STATE_COOKIE_MAX_AGE,
    path: `/api/${provider}/oauth`,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }

  return mismatch === 0
}
