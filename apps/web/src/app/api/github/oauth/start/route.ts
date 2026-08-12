import { NextRequest, NextResponse } from 'next/server'
import { SignJWT } from 'jose'
import { safeAuth } from '@/lib/safe-auth'
import { githubAuthorizeUrl, safeGithubReturnTo } from '@/lib/github-oauth'
import { configuredRedirectUri } from '@/lib/app-url'
import { getOAuthStateSecret, setOAuthStateCookie } from '@/lib/oauth-state'
import { db } from '@/lib/db'
import { isCurrentAuthVersion } from '@/lib/auth-version'

/** Start an OAuth link flow without changing the current ApplyMate identity. */
export async function GET(req: NextRequest) {
  const session = await safeAuth()
  if (!session?.user?.id) return NextResponse.redirect(new URL('/login', req.url))

  const user = await db.user.findUnique({ where: { id: session.user.id }, select: { accountStatus: true, authVersion: true } })
  if (!user) return NextResponse.redirect(new URL('/login?error=AccountUnavailable', req.url))
  if (user.accountStatus !== 'active') return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
  if (!isCurrentAuthVersion(session.user.authVersion, user.authVersion)) return NextResponse.json({ error: 'Session expired' }, { status: 401 })

  const clientId = process.env.AUTH_GITHUB_ID
  if (!clientId || !process.env.AUTH_GITHUB_SECRET) {
    return NextResponse.json({ error: 'GitHub OAuth is not configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  const stateSecret = getOAuthStateSecret()
  if (!stateSecret) {
    return NextResponse.json({ error: 'OAuth state signing is not configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  const returnTo = safeGithubReturnTo(new URL(req.url).searchParams.get('returnTo'))
  const nonce = crypto.randomUUID()
  const state = await new SignJWT({ uid: session.user.id, authVersion: user.authVersion, returnTo, nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .sign(stateSecret)
  const redirectUri = configuredRedirectUri(req.url, '/api/github/oauth/callback')
  const response = NextResponse.redirect(githubAuthorizeUrl(clientId, redirectUri, state))
  setOAuthStateCookie(response, 'github', nonce)
  return response
}
