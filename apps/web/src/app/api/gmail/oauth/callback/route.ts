/**
 * GET /api/gmail/oauth/callback
 *
 * Handles the Google OAuth redirect from /api/gmail/oauth/start. Exchanges the
 * authorization code for tokens and writes them to the Account table under the
 * current user's id (decoded from the signed state).
 *
 * Key difference from NextAuth's /api/auth/callback/google: this never changes
 * the session identity. It just attaches Google tokens to the existing user.
 *
 * Handles the unique([provider, providerAccountId]) conflict: if the Google
 * account is already linked to a *different* user record, that stale row is
 * removed first so the current user can take ownership of the tokens.
 */
import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { db } from '@/lib/db'

const JWT_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? 'fallback-secret-change-this',
)

export async function GET(req: NextRequest) {
  const url   = new URL(req.url)
  const code  = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errParam = url.searchParams.get('error')

  const back = (msg: string) => {
    const u = new URL('/', req.url)
    u.searchParams.set('page', 'gmail')
    u.searchParams.set('gmailError', msg)
    return NextResponse.redirect(u)
  }

  if (errParam) {
    console.error('[gmail/oauth/callback] google returned error:', errParam)
    return back(errParam)
  }
  if (!code || !state) return back('missing_code_or_state')

  // Verify state and extract userId
  let userId: string
  try {
    const { payload } = await jwtVerify(state, JWT_SECRET)
    if (!payload.uid || typeof payload.uid !== 'string') return back('invalid_state')
    userId = payload.uid
  } catch (e) {
    console.error('[gmail/oauth/callback] state verify failed:', e)
    return back('invalid_state')
  }

  // Exchange code for tokens
  const redirectUri = new URL('/api/gmail/oauth/callback', req.url).toString()
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  })
  const tokens = await tokenRes.json()
  if (!tokenRes.ok || !tokens.access_token) {
    console.error('[gmail/oauth/callback] token exchange failed:', tokens)
    return back('token_exchange_failed')
  }

  // Fetch Google user id (sub) — needed for providerAccountId uniqueness
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  const profile = await profileRes.json()
  const providerAccountId = profile.sub as string | undefined
  if (!providerAccountId) {
    console.error('[gmail/oauth/callback] no sub in userinfo:', profile)
    return back('no_provider_account_id')
  }

  const expires_at = tokens.expires_in
    ? Math.floor(Date.now() / 1000) + Number(tokens.expires_in)
    : null

  // If the same Google account is currently linked to a DIFFERENT user, remove
  // that stale link so the current user can take ownership.
  const existing = await db.account.findUnique({
    where: { provider_providerAccountId: { provider: 'google', providerAccountId } },
  })
  if (existing && existing.userId !== userId) {
    console.log('[gmail/oauth/callback] removing stale Google link for user', existing.userId)
    await db.account.delete({ where: { id: existing.id } })
  }

  // Upsert the current user's Google account row
  await db.account.upsert({
    where: { provider_providerAccountId: { provider: 'google', providerAccountId } },
    create: {
      userId,
      type:              'oauth',
      provider:          'google',
      providerAccountId,
      access_token:      tokens.access_token,
      refresh_token:     tokens.refresh_token ?? null,
      expires_at,
      token_type:        tokens.token_type ?? null,
      scope:             tokens.scope ?? null,
      id_token:          tokens.id_token ?? null,
    },
    update: {
      userId,
      access_token:  tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(expires_at != null   ? { expires_at }                          : {}),
      ...(tokens.scope         ? { scope:        tokens.scope }          : {}),
      ...(tokens.id_token      ? { id_token:     tokens.id_token }       : {}),
    },
  })

  console.log('[gmail/oauth/callback] linked Google account', providerAccountId, 'to user', userId, 'scope=', tokens.scope)

  const success = new URL('/', req.url)
  success.searchParams.set('page', 'gmail')
  success.searchParams.set('gmailAuth', '1')
  return NextResponse.redirect(success)
}
