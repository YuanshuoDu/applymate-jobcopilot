import { describe, expect, it } from 'vitest'
import {
  isRecoverableAuthSessionError,
  shouldSuppressAuthSessionErrorLog,
} from './safe-auth-errors'

describe('safe auth helpers', () => {
  it('treats stale encrypted JWT cookie errors as recoverable', () => {
    expect(isRecoverableAuthSessionError(new Error('JWTSessionError'))).toBe(true)
    expect(isRecoverableAuthSessionError(new Error('no matching decryption secret'))).toBe(true)
  })

  it('recognizes the Auth.js JWTSessionError wrapper around a decryption cause', () => {
    const error = Object.assign(
      new Error('Read more at https://errors.authjs.dev#jwtsessionerror'),
      {
        name: 'JWTSessionError',
        type: 'JWTSessionError',
        cause: { err: new Error('no matching decryption secret') },
      },
    )

    expect(isRecoverableAuthSessionError(error)).toBe(true)
  })

  it('does not hide unrelated auth errors', () => {
    expect(isRecoverableAuthSessionError(new Error('database unavailable'))).toBe(false)
  })

  it('only suppresses stale session cookie logs in development', () => {
    const staleCookieError = Object.assign(
      new Error('Read more at https://errors.authjs.dev#jwtsessionerror'),
      {
        name: 'JWTSessionError',
        cause: { err: new Error('no matching decryption secret') },
      },
    )

    expect(shouldSuppressAuthSessionErrorLog(staleCookieError, 'development')).toBe(true)
    expect(shouldSuppressAuthSessionErrorLog(staleCookieError, 'production')).toBe(false)
    expect(shouldSuppressAuthSessionErrorLog(new Error('database unavailable'), 'development')).toBe(false)
  })
})
