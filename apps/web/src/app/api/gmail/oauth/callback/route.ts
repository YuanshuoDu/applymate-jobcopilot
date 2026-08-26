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
 * A Gmail integration belongs to one ApplyMate user at a time. A user may
 * explicitly move it by starting OAuth with transfer=1 and authorizing Google.
 */
import { NextRequest, NextResponse } from 'next/server'
import { trackedExternalApiFetch } from '@/lib/api-usage/external-api-usage'
import { jwtVerify } from 'jose'
import { db } from '@/lib/db'
import { safeAuth } from '@/lib/safe-auth'
import { GMAIL_ACCOUNT_PROVIDER } from '@/lib/gmail-helpers'
import { encryptAccountTokenFields } from '@/lib/credential-secrets'
import { canRecoverStaleGmailConnection } from '@/lib/gmail-connection-recovery'
import { configuredRedirectUri } from '@/lib/app-url'
import { configuredAppOrigin } from '@/lib/app-url'
import {
  clearOAuthStateCookie,
  getOAuthStateSecret,
  hasMatchingOAuthStateCookie,
} from '@/lib/oauth-state'
import { isCurrentAuthVersion } from '@/lib/auth-version'

function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null
  try {
    const base = 'https://applymate.invalid'
    const parsed = new URL(value, base)
    return parsed.origin === base ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const url   = new URL(req.url)
  const code  = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errParam = url.searchParams.get('error')

  let returnTo = '/?page=gmail'
  let transferRequested = false
  const back = (msg: string) => {
    const u = new URL(returnTo, configuredAppOrigin(req.url))
    u.searchParams.set('gmailError', msg)
    const response = NextResponse.redirect(u)
    clearOAuthStateCookie(response, 'gmail')
    return response
  }

  if (errParam) {
    console.error('[gmail/oauth/callback] google returned error:', errParam)
    return back(errParam)
  }
  if (!code || !state) return back('missing_code_or_state')

  const stateSecret = getOAuthStateSecret()
  if (!stateSecret) return back('oauth_not_configured')

  // Verify the signed state and browser binding before using its user id.
  let userId: string
  let stateAuthVersion: number
  try {
    const { payload } = await jwtVerify(state, stateSecret)
    if (
      !payload.uid
      || typeof payload.uid !== 'string'
      || typeof payload.authVersion !== 'number'
      || !Number.isSafeInteger(payload.authVersion)
      || payload.authVersion < 1
      || typeof payload.nonce !== 'string'
      || !hasMatchingOAuthStateCookie(req, 'gmail', payload.nonce)
    ) return back('invalid_state')
    userId = payload.uid
    stateAuthVersion = payload.authVersion
    returnTo = safeReturnTo(payload.returnTo) ?? returnTo
    transferRequested = payload.transfer === true
  } catch (e) {
    console.error('[gmail/oauth/callback] state verify failed:', e)
    return back('invalid_state')
  }

  // The signed state belongs to the browser, not indefinitely to whichever
  // account first created it. A user can sign out or switch accounts while
  // Google is open; never attach that Google connection to the stale user.
  const session = await safeAuth()
  if (session?.user?.id !== userId) return back('session_mismatch')

  const user = await db.user.findUnique({ where: { id: userId }, select: { accountStatus: true, authVersion: true } })
  if (!user) return back('user_not_found')
  if (user.accountStatus !== 'active') return back('account_suspended')
  if (!isCurrentAuthVersion(stateAuthVersion, user.authVersion) || !isCurrentAuthVersion(session.user.authVersion, user.authVersion)) return back('session_expired')

  // Exchange code for tokens
  const redirectUri = configuredRedirectUri(req.url, '/api/gmail/oauth/callback')
  const tokenRes = await trackedExternalApiFetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  }, { provider: 'google-oauth', operation: 'token_exchange', credentialSource: 'user', userId })
  const tokens = await tokenRes.json()
  if (!tokenRes.ok || !tokens.access_token) {
    console.error('[gmail/oauth/callback] token exchange failed:', tokens)
    return back('token_exchange_failed')
  }

  // Fetch Google user id (sub) — needed for providerAccountId uniqueness
  const profileRes = await trackedExternalApiFetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }, { provider: 'google-oauth', operation: 'userinfo', credentialSource: 'user', userId })
  const profile = await profileRes.json()
  const providerAccountId = profile.sub as string | undefined
  if (!providerAccountId) {
    console.error('[gmail/oauth/callback] no sub in userinfo:', profile)
    return back('no_provider_account_id')
  }

  const expires_at = tokens.expires_in
    ? Math.floor(Date.now() / 1000) + Number(tokens.expires_in)
    : null

  // Gmail integration credentials use their own provider namespace. Never
  // overwrite an Auth.js Google identity row.
  const existing = await db.account.findUnique({
    where: { provider_providerAccountId: { provider: GMAIL_ACCOUNT_PROVIDER, providerAccountId } },
    select: { id: true, userId: true },
  })
  let recoveredLegacyConnection = false
  let transferredConnection = false
  if (existing && existing.userId !== userId) {
    // The previous implementation stored Gmail credentials on a `google`
    // login row. When that identity is later repaired from a demo user to its
    // verified owner, its separately migrated Gmail row can be left behind.
    // Recover a legacy row when the same Google subject is already the current
    // user's Auth.js identity, or honor an explicit transfer request signed
    // into the OAuth state after the user clicked Connect.
    const googleLogin = await db.account.findUnique({
      where: { provider_providerAccountId: { provider: 'google', providerAccountId } },
      select: { userId: true },
    })
    if (!canRecoverStaleGmailConnection({
      existingConnectionUserId: existing.userId,
      currentUserId: userId,
      googleLoginUserId: googleLogin?.userId,
      transferRequested,
    })) {
      return back('google_account_already_connected')
    }
    recoveredLegacyConnection = googleLogin?.userId === userId
    transferredConnection = transferRequested
  }

  try {
    await db.account.deleteMany({
      where: { userId, provider: GMAIL_ACCOUNT_PROVIDER, NOT: { providerAccountId } },
    })

    const encryptedTokens = await encryptAccountTokenFields({
      provider: GMAIL_ACCOUNT_PROVIDER,
      providerAccountId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token ?? null,
    })

    // Upsert the current user's isolated Gmail connection.
    await db.account.upsert({
      where: { provider_providerAccountId: { provider: GMAIL_ACCOUNT_PROVIDER, providerAccountId } },
      create: {
        userId,
        type:              'oauth',
        provider:          GMAIL_ACCOUNT_PROVIDER,
        providerAccountId,
        ...encryptedTokens,
        expires_at,
        token_type:        tokens.token_type ?? null,
        scope:             tokens.scope ?? null,
      },
      update: {
        ...(recoveredLegacyConnection || transferredConnection ? { userId } : {}),
        access_token:  null,
        accessTokenEnc: encryptedTokens.accessTokenEnc,
        ...(tokens.refresh_token ? { refresh_token: null, refreshTokenEnc: encryptedTokens.refreshTokenEnc } : {}),
        ...(expires_at != null   ? { expires_at }                          : {}),
        ...(tokens.scope         ? { scope:        tokens.scope }          : {}),
        ...(tokens.id_token      ? { id_token: null, idTokenEnc: encryptedTokens.idTokenEnc } : {}),
      },
    })
  } catch (error) {
    console.error('[gmail/oauth/callback] credential persistence failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error).slice(0, 200),
    })
    return back('credential_storage_unavailable')
  }

  console.log(
    transferredConnection
      ? '[gmail/oauth/callback] transferred Gmail connection to current user'
      : recoveredLegacyConnection
        ? '[gmail/oauth/callback] recovered stale Gmail connection for current user'
      : '[gmail/oauth/callback] linked Gmail integration to current user',
  )

  const success = new URL(returnTo, configuredAppOrigin(req.url))
  success.searchParams.set('gmailAuth', '1')
  const response = NextResponse.redirect(success)
  clearOAuthStateCookie(response, 'gmail')
  return response
}
