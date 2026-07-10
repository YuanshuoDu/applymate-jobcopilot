import { describe, expect, it } from 'vitest'
import { isRecoverableAuthSessionError } from './safe-auth-errors'

describe('safe auth helpers', () => {
  it('treats stale encrypted JWT cookie errors as recoverable', () => {
    expect(isRecoverableAuthSessionError(new Error('JWTSessionError'))).toBe(true)
    expect(isRecoverableAuthSessionError(new Error('no matching decryption secret'))).toBe(true)
  })

  it('does not hide unrelated auth errors', () => {
    expect(isRecoverableAuthSessionError(new Error('database unavailable'))).toBe(false)
  })
})
