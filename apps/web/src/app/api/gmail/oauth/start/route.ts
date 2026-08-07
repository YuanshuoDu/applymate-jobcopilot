/**
 * GET /api/gmail/oauth/start
 *
 * Starts a Google OAuth flow scoped to Gmail, *independent* from the NextAuth
 * session sign-in flow. This lets a credentials-logged-in user attach a Google
 * account (possibly with a different email) to their existing user record —
 * which NextAuth's signIn('google') cannot do (it would throw OAuthAccountNotLinked
 * and switch session identity).
 *
 * The current authenticated userId is signed into the `state` param so the
 * callback can attribute the resulting tokens to the right user.
 */
import { NextRequest, NextResponse } from 'next/server'
import { SignJWT } from 'jose'
import { safeAuth } from '@/lib/safe-auth'
import { configuredRedirectUri } from '@/lib/app-url'
import { getOAuthStateSecret, setOAuthStateCookie } from '@/lib/oauth-state'

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ')

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/')) return '/?page=gmail'
  try {
    const base = 'https://applymate.invalid'
    const parsed = new URL(value, base)
    if (parsed.origin !== base) return '/?page=gmail'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/?page=gmail'
  }
}

export async function GET(req: NextRequest) {
  const session = await safeAuth()
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  const clientId = process.env.AUTH_GOOGLE_ID
  if (!clientId || !process.env.AUTH_GOOGLE_SECRET) {
    return NextResponse.json({ error: 'Google OAuth not configured' }, { status: 500 })
  }
  const stateSecret = getOAuthStateSecret()
  if (!stateSecret) {
    return NextResponse.json({ error: 'OAuth state signing is not configured' }, { status: 503 })
  }

  // Bind the signed callback state to the browser that initiated this flow.
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'))
  const transfer = req.nextUrl.searchParams.get('transfer') === '1'
  const nonce = crypto.randomUUID()
  const state = await new SignJWT({ uid: session.user.id, nonce, returnTo, transfer })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .sign(stateSecret)

  const redirectUri = configuredRedirectUri(req.url, '/api/gmail/oauth/callback')

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id',     clientId)
  url.searchParams.set('redirect_uri',  redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope',         SCOPES)
  url.searchParams.set('access_type',   'offline')
  url.searchParams.set('prompt',        'consent')
  url.searchParams.set('state',         state)
  url.searchParams.set('include_granted_scopes', 'true')

  const response = NextResponse.redirect(url.toString())
  setOAuthStateCookie(response, 'gmail', nonce)
  return response
}
