import { isCurrentAuthVersion } from './auth-version'
import { normalizeEmail } from './auth-identifiers'

type SessionToken = {
  id?: unknown
  sub?: unknown
  email?: unknown
  plan?: unknown
  authVersion?: unknown
  [key: string]: unknown
}

type CurrentUser = {
  accountStatus: string
  authVersion: number
  plan: string
}

type CurrentEmailUser = CurrentUser & {
  id: string
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
 * A narrow legacy migration path for signed Auth.js tokens which pre-date the
 * `sub` / application `id` claims. Do not return an email when a token has
 * any identity claim (including conflicting claims); those states must not be
 * converted into another account identity.
 */
export function sessionTokenEmail(token: SessionToken): string | null {
  const tokenId = typeof token.id === 'string' && token.id ? token.id : null
  const subject = typeof token.sub === 'string' && token.sub ? token.sub : null
  if (tokenId || subject || typeof token.email !== 'string') return null

  const email = normalizeEmail(token.email)
  return email || null
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

/**
 * Upgrade a signed, email-only legacy token after the database establishes a
 * unique active account at the token's current authentication revision.
 */
export function refreshEmailOnlySessionToken<T extends SessionToken>(
  token: T,
  currentUser: CurrentEmailUser | null,
): T | Record<string, never> {
  if (
    !sessionTokenEmail(token)
    || !currentUser
    || currentUser.accountStatus !== 'active'
    || !isCurrentAuthVersion(token.authVersion, currentUser.authVersion)
  ) return {}

  token.id = currentUser.id
  token.authVersion = currentUser.authVersion
  token.plan = currentUser.plan
  return token
}
