import { isCurrentAuthVersion } from './auth-version'

type SessionToken = {
  id?: unknown
  sub?: unknown
  plan?: unknown
  authVersion?: unknown
  [key: string]: unknown
}

type CurrentUser = {
  accountStatus: string
  authVersion: number
  plan: string
}

/**
 * Auth.js used `sub` as the user identifier before ApplyMate added the
 * application-level `id` claim. Accept that legacy representation only after
 * the current account lifecycle and revocation version have been checked.
 */
export function refreshExistingSessionToken<T extends SessionToken>(
  token: T,
  currentUser: CurrentUser | null,
): T | Record<string, never> {
  const tokenId = typeof token.id === 'string' && token.id ? token.id : null
  const subject = typeof token.sub === 'string' && token.sub ? token.sub : null

  // A signed token with two conflicting identities must never be normalized.
  if ((tokenId && subject && tokenId !== subject) || (!tokenId && !subject)) return {}

  const userId = tokenId ?? subject
  if (
    !currentUser
    || currentUser.accountStatus !== 'active'
    || !isCurrentAuthVersion(token.authVersion, currentUser.authVersion)
  ) return {}

  token.id = userId
  token.authVersion = currentUser.authVersion
  token.plan = currentUser.plan
  return token
}
