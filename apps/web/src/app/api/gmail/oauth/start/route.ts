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
import { getAuthJwtSecret } from '@/lib/auth-secret'
import { db } from '@/lib/db'

const JWT_SECRET = getAuthJwtSecret()

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

  const user = await db.user.findUnique({ where: { id: session.user.id }, select: { accountStatus: true } })
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  if (user.accountStatus === 'suspended') return NextResponse.json({ error: 'Account suspended' }, { status: 403 })

  const clientId = process.env.AUTH_GOOGLE_ID
  if (!clientId) {
    return NextResponse.json({ error: 'Google OAuth not configured' }, { status: 500 })
  }

  // Sign both user and a same-origin return location into state. The callback
  // can then attach Gmail without changing the active application identity.
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'))
  const transfer = req.nextUrl.searchParams.get('transfer') === '1'
  const state = await new SignJWT({ uid: session.user.id, nonce: crypto.randomUUID(), returnTo, transfer })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .sign(JWT_SECRET)

  const redirectUri = new URL('/api/gmail/oauth/callback', req.url).toString()

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id',     clientId)
  url.searchParams.set('redirect_uri',  redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope',         SCOPES)
  url.searchParams.set('access_type',   'offline')
  url.searchParams.set('prompt',        'consent')
  url.searchParams.set('state',         state)
  url.searchParams.set('include_granted_scopes', 'true')

  return NextResponse.redirect(url.toString())
}
