import { describe, expect, it } from 'vitest'
import { credentialsSignInMessage, signInUrlErrorMessage } from './auth-errors'

describe('credentials sign-in errors', () => {
  it('keeps credential failures generic', () => {
    expect(credentialsSignInMessage('CredentialsSignin')).toBe('Invalid email or password.')
  })

  it('does not mislabel service failures as bad credentials', () => {
    expect(credentialsSignInMessage('CallbackRouteError')).toBe('Sign-in is temporarily unavailable. Please try again.')
    expect(credentialsSignInMessage('Configuration')).toBe('Sign-in is temporarily unavailable. Please try again.')
    expect(credentialsSignInMessage(undefined)).toBe('Sign-in is temporarily unavailable. Please try again.')
  })
})

describe('URL sign-in errors', () => {
  it('keeps the intended administrator denial explanation', () => {
    expect(signInUrlErrorMessage('not_admin')).toBe('This account is not an administrator. Administrator access is invitation-only.')
  })

  it('does not echo malformed or internal Auth.js error values', () => {
    expect(signInUrlErrorMessage('undefined')).toBe('Sign-in is temporarily unavailable. Please try again.')
    expect(signInUrlErrorMessage('Configuration')).toBe('Sign-in is temporarily unavailable. Please try again.')
  })
})
