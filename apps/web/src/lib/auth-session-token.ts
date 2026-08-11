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
 * The application id claim was introduced after Auth.js had already issued
 * sessions that identify their user only through the standard `sub` claim.
 * A token that supplies conflicting claims is not a safe session identity.
 */
export function sessionTokenUserId(token: SessionToken): string | null {
  const tokenId = typeof token.id === 'string' && token.id ? token.id : null
  const subject = typeof token.sub === 'string' && token.sub ? token.sub : null

  if ((tokenId && subject && tokenId !== subject) || (!tokenId && !subject)) return null
  return tokenId ?? subject
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
  const userId = sessionTokenUserId(token)
  if (
    !userId
    || !currentUser
    || currentUser.accountStatus !== 'active'
    || !isCurrentAuthVersion(token.authVersion, currentUser.authVersion)
  ) return {}

  token.id = userId
  token.authVersion = currentUser.authVersion
  token.plan = currentUser.plan
  return token
}
