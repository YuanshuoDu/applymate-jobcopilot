import { describe, expect, it } from 'vitest'

import { authVersionFromClaim, INITIAL_AUTH_VERSION, isCurrentAuthVersion } from './auth-version'

describe('authentication version claims', () => {
  it('treats legacy claims as the initial authentication version', () => {
    expect(authVersionFromClaim(undefined)).toBe(INITIAL_AUTH_VERSION)
    expect(authVersionFromClaim('1')).toBe(INITIAL_AUTH_VERSION)
    expect(authVersionFromClaim(0)).toBe(INITIAL_AUTH_VERSION)
  })

  it('invalidates a session when its authentication version changes', () => {
    expect(isCurrentAuthVersion(2, 2)).toBe(true)
    expect(isCurrentAuthVersion(1, 2)).toBe(false)
  })
})
