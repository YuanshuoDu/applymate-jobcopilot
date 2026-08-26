import { NextRequest, NextResponse } from 'next/server'
import { trackedExternalApiFetch } from '@/lib/api-usage/external-api-usage'
import { jwtVerify } from 'jose'
import { db } from '@/lib/db'
import { safeAuth } from '@/lib/safe-auth'
import { encryptAccountTokenFields } from '@/lib/credential-secrets'
import { githubCallbackRedirect, safeGithubReturnTo } from '@/lib/github-oauth'
import { configuredAppOrigin, configuredRedirectUri } from '@/lib/app-url'
import {
  clearOAuthStateCookie,
  getOAuthStateSecret,
  hasMatchingOAuthStateCookie,
} from '@/lib/oauth-state'
import { isCurrentAuthVersion } from '@/lib/auth-version'

type GithubToken = { access_token?: unknown; token_type?: unknown; scope?: unknown }
type GithubProfile = { id?: unknown; login?: unknown }

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')
  let returnTo = safeGithubReturnTo(null)

  const publicOrigin = configuredAppOrigin(req.url)
  const back = (reason: string) => {
    const response = NextResponse.redirect(githubCallbackRedirect(returnTo, publicOrigin, 'githubError', reason))
    clearOAuthStateCookie(response, 'github')
    return response
  }
  if (oauthError) return back('oauth_denied')
  if (!code || !state) return back('missing_code_or_state')

  const stateSecret = getOAuthStateSecret()
  if (!stateSecret) return back('oauth_not_configured')

  let userId: string
  let stateAuthVersion: number
  try {
    const verified = await jwtVerify(state, stateSecret)
    if (
      typeof verified.payload.uid !== 'string'
      || !verified.payload.uid
      || typeof verified.payload.authVersion !== 'number'
      || !Number.isSafeInteger(verified.payload.authVersion)
      || verified.payload.authVersion < 1
      || typeof verified.payload.nonce !== 'string'
      || !hasMatchingOAuthStateCookie(req, 'github', verified.payload.nonce)
    ) return back('invalid_state')
    userId = verified.payload.uid
    stateAuthVersion = verified.payload.authVersion
    returnTo = safeGithubReturnTo(verified.payload.returnTo)
  } catch {
    return back('invalid_state')
  }

  // Bind completion to the account that started the flow as well as the
  // browser nonce. Otherwise a user switch during GitHub authorization could
  // attach external credentials to the stale account in the signed state.
  const session = await safeAuth()
  if (session?.user?.id !== userId) return back('session_mismatch')

  const owner = await db.user.findUnique({ where: { id: userId }, select: { id: true, accountStatus: true, authVersion: true } })
  if (!owner) return back('user_not_found')
  if (owner.accountStatus !== 'active') return back('account_suspended')
  if (!isCurrentAuthVersion(stateAuthVersion, owner.authVersion) || !isCurrentAuthVersion(session.user.authVersion, owner.authVersion)) return back('session_expired')

  const clientId = process.env.AUTH_GITHUB_ID
  const clientSecret = process.env.AUTH_GITHUB_SECRET
  if (!clientId || !clientSecret) return back('oauth_not_configured')

  const tokenResponse = await trackedExternalApiFetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: configuredRedirectUri(req.url, '/api/github/oauth/callback') }),
  }, { provider: 'github', operation: 'token_exchange', credentialSource: 'user', userId }).catch(() => null)
  const token = await tokenResponse?.json().catch(() => null) as GithubToken | null
  if (!tokenResponse?.ok || typeof token?.access_token !== 'string' || !token.access_token) return back('token_exchange_failed')

  const profileResponse = await trackedExternalApiFetch('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'ApplyMate' },
  }, { provider: 'github', operation: 'profile', credentialSource: 'user', userId }).catch(() => null)
  const profile = await profileResponse?.json().catch(() => null) as GithubProfile | null
  if (!profileResponse?.ok || (typeof profile?.id !== 'number' && typeof profile?.id !== 'string')) return back('profile_fetch_failed')
  const providerAccountId = String(profile.id)

  const existing = await db.account.findUnique({
    where: { provider_providerAccountId: { provider: 'github', providerAccountId } },
    select: { userId: true },
  })
  if (existing && existing.userId !== userId) return back('github_account_already_connected')

  const encryptedTokens = await encryptAccountTokenFields({
    provider: 'github',
    providerAccountId,
    accessToken: token.access_token,
  })

  await db.account.upsert({
    where: { provider_providerAccountId: { provider: 'github', providerAccountId } },
    create: {
      userId, type: 'oauth', provider: 'github', providerAccountId,
      ...encryptedTokens,
      token_type: typeof token.token_type === 'string' ? token.token_type : null,
      scope: typeof token.scope === 'string' ? token.scope : 'read:user user:email',
    },
    update: {
      userId, access_token: null, accessTokenEnc: encryptedTokens.accessTokenEnc,
      ...(typeof token.token_type === 'string' ? { token_type: token.token_type } : {}),
      ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
    },
  })

  const response = NextResponse.redirect(githubCallbackRedirect(returnTo, publicOrigin, 'githubAuth', '1'))
  clearOAuthStateCookie(response, 'github')
  return response
}
