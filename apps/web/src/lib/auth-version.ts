export const INITIAL_AUTH_VERSION = 1

/**
 * Older browser and extension sessions did not carry an authentication
 * revision. They are version one so the migration preserves active sessions
 * while still invalidating them after the next security-sensitive change.
 */
export function authVersionFromClaim(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= INITIAL_AUTH_VERSION
    ? value
    : INITIAL_AUTH_VERSION
}

export function isCurrentAuthVersion(claim: unknown, currentVersion: number): boolean {
  return authVersionFromClaim(claim) === currentVersion
}
